import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	InstanceBase,
	runEntrypoint,
	InstanceStatus,
	SomeCompanionConfigField,
	combineRgb,
	CompanionButtonPresetDefinition,
	CompanionPresetDefinitions,
	Regex,
} from '@companion-module/base'

import { Client, Server, Message, MessageLike } from 'node-osc'
import { debounce, debounceGather } from './utils/debounce'
import { Action, Feedback } from './enums'

interface Config {
	/** The host registered in AbleSet for updates */
	clientHost: string
	/** The port used to listen to updates */
	clientPort: string
	/** The hostname or IP address to connect to  */
	serverHost: string
}

/**
 * Returns an array of numbers from 0 to, and including the given number.
 * @example makeRange(2) // returns [0, 1, 2]
 */
const makeRange = (number: number) =>
	Array(number)
		.fill(0)
		.map((_, i) => i)

const COLOR_BLACK = combineRgb(0, 0, 0)
const COLOR_GRAY = combineRgb(128, 128, 128)
const COLOR_WHITE = combineRgb(255, 255, 255)
const COLOR_GREEN_500 = combineRgb(34, 197, 94)
const COLOR_GREEN_700 = combineRgb(21, 128, 61)
const COLOR_GREEN_800 = combineRgb(22, 101, 52)

const PLAY_ICON = '<icon:play.png>'
const PAUSE_ICON_GREEN = '<icon:pause-green.png>'
const STOP_ICON_GREEN = '<icon:stop-green.png>'
const LOOP_ICON = '<icon:loop.png>'
const LOOP_ICON_GRAY = '<icon:loop-gray.png>'
const LOOP_ICON_GREEN = '<icon:loop-green.png>'

const PRESET_COUNT = 32

class ModuleInstance extends InstanceBase<Config> {
	config: Config = { clientHost: '127.0.0.1', clientPort: '39052', serverHost: '127.0.0.1' }
	oscServer: Server | null = null
	oscClient: Client | null = null

	songs: string[] = []
	sections: string[] = []

	constructor(internal: any) {
		super(internal)
	}

	async init(config: Config) {
		this.log('info', 'Initializing...')
		this.config = config

		if (
			config.serverHost !== '127.0.0.1' &&
			config.serverHost !== 'localhost' &&
			(!config.clientHost || config.clientHost === '127.0.0.1' || config.clientHost === 'localhost')
		) {
			this.updateStatus(
				InstanceStatus.BadConfig,
				"You must provide an IP address for AbleSet to send updates to when AbleSet isn't running on this machine, and it can't be 127.0.0.1 or localhost."
			)
			return
		}

		this.updateStatus(InstanceStatus.Connecting)

		try {
			const clientPort = Number(this.config.clientPort)

			if (isNaN(clientPort)) {
				throw new Error('Client port is not valid: ' + this.config.clientPort)
			}

			this.oscServer = new Server(clientPort, config.clientHost)
			this.oscClient = new Client(this.config.serverHost, 39051)
			this.log('info', `OSC client is sending to ${this.config.serverHost}:39051`)

			this.initOscListeners(this.oscServer)

			let isConnected = false

			const handleHeartbeat = debounce(() => {
				this.log('warn', 'took too long between heartbeats, connection likely lost')
				this.updateStatus(InstanceStatus.Disconnected, "Didn't receive a heartbeat in a while")
				isConnected = false
			}, 2500)

			this.oscServer.on('listening', () => {
				this.log('info', `OSC server is listening on port ${clientPort}`)
				this.sendOsc(['/subscribe', config.clientHost, clientPort, 'Companion'])
				this.sendOsc(['/getValues'])
				handleHeartbeat()
			})

			this.oscServer.once('/global/isPlaying', () => {
				isConnected = true
				this.log('info', 'connection established')
				this.updateStatus(InstanceStatus.Ok)
			})

			this.oscServer.on('/heartbeat', () => {
				if (!isConnected) {
					isConnected = true
					this.log('info', 'got another heartbeat, connection re-established')
					this.updateStatus(InstanceStatus.Ok)
				}
				handleHeartbeat()
			})

			this.oscServer.on('error', (error) => {
				this.log('error', String(error))
				console.error('OSC Error:', error)
				this.updateStatus(InstanceStatus.ConnectionFailure, error.message)
			})
		} catch (e: any) {
			console.error('OSC Init Error:', e)
			this.updateStatus(InstanceStatus.ConnectionFailure, String(e.message ?? e))
		}

		this.updateActions() // export actions
		this.updatePresets() // export presets
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
	}

	sendOsc(message: string | Message | MessageLike) {
		if (this.oscClient) {
			this.log('info', 'sending message: ' + JSON.stringify(message))
			this.oscClient.send(message)
		} else {
			this.log('error', "OSC client doesn't exist")
		}
	}

	/** Waits until all new OSC values are received before running updates */
	debouncedCheckFeedbacks = debounceGather<Feedback>((types) => this.checkFeedbacks(...types), 50)

	initOscListeners(server: Server) {
		//#region global
		server.on('/global/beatsPosition', ([, beats]) => {
			this.setVariableValues({ beatsPosition: Number(beats) })
			this.debouncedCheckFeedbacks(Feedback.IsInLoop, Feedback.IsInActiveLoop)
		})
		server.on('/global/humanPosition', ([, bars, beats]) => {
			this.setVariableValues({ humanPosition: `${bars ?? 0}.${beats ?? 0}` })
		})
		server.on('/global/tempo', ([, tempo]) => {
			this.setVariableValues({ tempo: Number(tempo) })
		})
		server.on('/global/isPlaying', ([, isPlaying]) => {
			this.setVariableValues({ isPlaying: Boolean(isPlaying) })
			this.debouncedCheckFeedbacks(Feedback.IsPlaying)
		})
		server.on('/global/timeSignature', ([, numerator, denominator]) => {
			this.setVariableValues({ timeSignature: `${numerator}/${denominator}` })
		})
		//#endregion

		//#region setlist
		server.on('/setlist/name', ([, name]) => {
			this.setVariableValues({ setlistName: String(name) })
		})
		server.on('/setlist/songs', ([, ...songs]) => {
			this.songs = songs as string[]
			this.setVariableValues(
				Object.fromEntries(makeRange(PRESET_COUNT).map((i) => [`song${i + 1}Name`, String(songs[i] ?? '')]))
			)
			this.debouncedCheckFeedbacks(Feedback.CanJumpToNextSong, Feedback.CanJumpToPreviousSong)
		})
		server.on('/setlist/sections', ([, ...sections]) => {
			this.sections = sections as string[]
			this.setVariableValues(
				Object.fromEntries(makeRange(PRESET_COUNT).map((i) => [`section${i + 1}Name`, String(sections[i] ?? '')]))
			)
			this.debouncedCheckFeedbacks(Feedback.CanJumpToNextSection, Feedback.CanJumpToPreviousSection)
		})
		server.on('/setlist/activeSongName', ([, activeSongName]) => {
			this.setVariableValues({ activeSongName: String(activeSongName) })
		})
		server.on('/setlist/activeSongIndex', ([, activeSongIndex]) => {
			this.setVariableValues({ activeSongIndex: Number(activeSongIndex) })
			this.debouncedCheckFeedbacks(Feedback.IsCurrentSong, Feedback.CanJumpToNextSong, Feedback.CanJumpToPreviousSong)
		})
		server.on('/setlist/activeSectionName', ([, activeSectionName]) => {
			this.setVariableValues({ activeSectionName: String(activeSectionName) })
		})
		server.on('/setlist/activeSectionIndex', ([, activeSectionIndex]) => {
			this.setVariableValues({ activeSectionIndex: Number(activeSectionIndex) })
			this.debouncedCheckFeedbacks(
				Feedback.IsCurrentSection,
				Feedback.CanJumpToNextSection,
				Feedback.CanJumpToPreviousSection
			)
		})
		server.on('/setlist/queuedName', ([, queuedSong, queuedSection]) => {
			this.setVariableValues({
				queuedSongName: String(queuedSong),
				queuedSectionName: String(queuedSection),
			})
		})
		server.on('/setlist/queuedIndex', ([, queuedSong, queuedSection]) => {
			this.setVariableValues({
				queuedSongIndex: Number(queuedSong),
				queuedSectionIndex: Number(queuedSection),
			})
			this.debouncedCheckFeedbacks(Feedback.IsQueuedSong, Feedback.IsQueuedSection)
		})
		server.on('/setlist/nextSongName', ([, nextSongName]) => {
			this.setVariableValues({ nextSongName: String(nextSongName) })
		})
		server.on('/setlist/nextSongIndex', ([, nextSongIndex]) => {
			this.setVariableValues({ nextSongIndex: Number(nextSongIndex) })
		})
		server.on('/setlist/loopEnabled', ([, loopEnabled]) => {
			this.setVariableValues({ loopEnabled: Boolean(loopEnabled) })
			this.debouncedCheckFeedbacks(Feedback.IsInLoop, Feedback.IsInActiveLoop)
		})
		server.on('/setlist/loopStart', ([, loopStart]) => {
			this.setVariableValues({ loopStart: Number(loopStart) })
			this.debouncedCheckFeedbacks(Feedback.IsInLoop, Feedback.IsInActiveLoop)
		})
		server.on('/setlist/loopEnd', ([, loopEnd]) => {
			this.setVariableValues({ loopEnd: Number(loopEnd) })
			this.debouncedCheckFeedbacks(Feedback.IsInLoop, Feedback.IsInActiveLoop)
		})
		server.on('/setlist/isCountingIn', ([, isCountingIn]) => {
			this.setVariableValues({ isCountingIn: Boolean(isCountingIn) })
		})
		//#endregion

		//#region PlayAUDIO12
		server.on('/playaudio12/isConnected', ([, connected]) => {
			this.setVariableValues({ playAudio12Connected: Boolean(connected) })
		})
		server.on('/playaudio12/scene', ([, scene]) => {
			this.setVariableValues({ playAudio12Scene: Number(scene) })
		})
		//#endregion

		//#region settings
		server.on('/settings/autoplay', ([, value]) => {
			this.setVariableValues({ autoplay: Boolean(value) })
		})
		server.on('/settings/safeMode', ([, value]) => {
			this.setVariableValues({ safeMode: Boolean(value) })
		})
		server.on('/settings/alwaysStopOnSongEnd', ([, value]) => {
			this.setVariableValues({ alwaysStopOnSongEnd: Boolean(value) })
		})
		server.on('/settings/autoJumpToNextSong', ([, value]) => {
			this.setVariableValues({ autoJumpToNextSong: Boolean(value) })
		})
		server.on('/settings/autoLoopCurrentSection', ([, value]) => {
			this.setVariableValues({ autoLoopCurrentSection: Boolean(value) })
		})
		server.on('/settings/countIn', ([, value]) => {
			this.setVariableValues({ countIn: Boolean(value) })
		})
		server.on('/settings/countInSoloClick', ([, value]) => {
			this.setVariableValues({ countInSoloClick: Boolean(value) })
		})
		server.on('/settings/countInDuration', ([, value]) => {
			this.setVariableValues({ countInDuration: Number(value) })
		})
		server.on('/settings/jumpMode', ([, value]) => {
			this.setVariableValues({ jumpMode: String(value) })
		})
		//#endregion
	}

	isInActiveLoop() {
		const pos = Number(this.getVariableValue('beatsPosition'))
		return (
			Boolean(this.getVariableValue('loopEnabled')) &&
			pos >= Number(this.getVariableValue('loopStart')) &&
			pos <= Number(this.getVariableValue('loopEnd'))
		)
	}

	// When module gets deleted
	async destroy() {
		this.log('debug', 'destroying module...')
		this.sendOsc('/unsubscribe')
		await new Promise<void>((res) => this.oscClient?.close(res))
		await new Promise<void>((res) => this.oscServer?.close(res))
		this.log('debug', 'module destroyed')
	}

	async configUpdated(config: Config) {
		this.config = config
		this.log('info', 'got new config: ' + JSON.stringify(config))

		await this.destroy()
		await this.init(config)
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return [
			{
				id: 'clientHost',
				type: 'textinput',
				label: 'Client Host/IP',
				tooltip:
					"The IP address AbleSet should send updates to. Set the value to this computer's IP address if you run AbleSet on a different computer thank this one.",
				regex: Regex.HOSTNAME,
				default: '127.0.0.1',
				width: 4,
			},
			{
				id: 'clientPort',
				type: 'textinput',
				label: 'Client Port',
				tooltip: 'The port used to listen to status updates. Only change this if the default port causes issues',
				regex: Regex.PORT,
				default: '39052',
				width: 4,
			},
			{
				id: 'serverHost',
				type: 'textinput',
				label: 'Server Host/IP',
				tooltip:
					'The host to connect to. Leave this as 127.0.0.1 is AbleSet is running on the same computer as Companion.',
				regex: Regex.HOSTNAME,
				default: '127.0.0.1',
				width: 4,
			},
		]
	}

	updateActions() {
		this.setActionDefinitions({
			//#region global
			[Action.Play]: {
				name: 'Play',
				options: [],
				callback: async () => this.sendOsc(['/global/play']),
			},
			[Action.Pause]: {
				name: 'Pause',
				options: [],
				callback: async () => this.sendOsc(['/global/pause']),
			},
			[Action.Stop]: {
				name: 'Stop',
				options: [],
				callback: async () => this.sendOsc(['/global/stop']),
			},
			[Action.PlayPause]: {
				name: 'Toggle Play/Pause',
				options: [],
				callback: async () => {
					if (this.getVariableValue('isPlaying')) {
						this.sendOsc(['/global/pause'])
					} else {
						this.sendOsc(['/global/play'])
					}
				},
			},
			[Action.PlayStop]: {
				name: 'Toggle Play/Stop',
				options: [],
				callback: async () => {
					if (this.getVariableValue('isPlaying')) {
						this.sendOsc(['/global/stop'])
					} else {
						this.sendOsc(['/global/play'])
					}
				},
			},
			//#endregion

			//#region setlist
			[Action.EnableLoop]: {
				name: 'Enable Loop',
				options: [],
				callback: async () => this.sendOsc(['/setlist/enableLoop']),
			},
			[Action.EscapeLoop]: {
				name: 'Escape Loop',
				options: [],
				callback: async () => this.sendOsc(['/setlist/escapeLoop']),
			},
			[Action.ToggleLoop]: {
				name: 'Toggle Loop',
				options: [],
				callback: async () => {
					if (this.isInActiveLoop()) {
						this.sendOsc(['/setlist/escapeLoop'])
					} else {
						this.sendOsc(['/setlist/enableLoop'])
					}
				},
			},
			[Action.JumpToSongByNumber]: {
				name: 'Jump to Song by Number',
				options: [
					{
						id: 'number',
						type: 'number',
						label: 'Song Number',
						min: 1,
						max: 1000,
						default: 1,
					},
				],
				callback: async (event) => this.sendOsc(['/setlist/jumpToSong', Number(event.options.number)]),
			},
			[Action.JumpToSongByName]: {
				name: 'Jump to Song by Name',
				options: [
					{
						id: 'name',
						type: 'textinput',
						label: 'Song Name',
						required: true,
					},
				],
				callback: async (event) => this.sendOsc(['/setlist/jumpToSong', String(event.options.name)]),
			},
			[Action.JumpBySongs]: {
				name: 'Jump by Songs',
				options: [
					{
						id: 'steps',
						type: 'number',
						label: 'Steps',
						tooltip: '1 jumps to the next song, -1 jumps to the previous song',
						min: -10,
						max: 10,
						default: 1,
					},
				],
				callback: async (event) => this.sendOsc(['/setlist/jumpBySongs', Number(event.options.steps)]),
			},
			[Action.JumpToSectionByNumber]: {
				name: 'Jump to Section by Number',
				options: [
					{
						id: 'number',
						type: 'number',
						label: 'Section Number',
						min: 1,
						max: 1000,
						default: 1,
					},
				],
				callback: async (event) => this.sendOsc(['/setlist/jumpToSection', Number(event.options.number)]),
			},
			[Action.JumpToSectionByName]: {
				name: 'Jump to Section by Name',
				options: [
					{
						id: 'name',
						type: 'textinput',
						label: 'Section Name',
						required: true,
					},
				],
				callback: async (event) => this.sendOsc(['/setlist/jumpToSection', String(event.options.name)]),
			},
			[Action.JumpBySections]: {
				name: 'Jump by Sections',
				options: [
					{
						id: 'steps',
						type: 'number',
						label: 'Steps',
						tooltip: '1 jumps to the next song, -1 jumps to the previous song',
						min: -10,
						max: 10,
						default: 1,
					},
				],
				callback: async (event) => this.sendOsc(['/setlist/jumpBySections', Number(event.options.steps)]),
			},
			[Action.PlayCuedSong]: {
				name: 'Play Cued Song',
				options: [],
				callback: async () => this.sendOsc(['/setlist/playCuedSong']),
			},
			//#endregion

			//#region PlayAUDIO12
			[Action.Pa12SetScene]: {
				name: 'PlayAUDIO12: Set Scene',
				options: [
					{
						id: 'scene',
						label: 'Scene',
						type: 'dropdown',
						choices: [
							{ id: 'A', label: 'Scene A' },
							{ id: 'B', label: 'Scene B' },
						],
						default: 'A',
					},
				],
				callback: async (event) => this.sendOsc(['/playaudio12/setScene', String(event.options.scene)]),
			},
			[Action.Pa12ToggleScene]: {
				name: 'PlayAUDIO12: Toggle Scene',
				options: [],
				callback: async () => this.sendOsc(['/playaudio12/toggleScene']),
			},

			//#endregion

			//#region settings
			[Action.SetAutoplay]: {
				name: 'Set Autoplay',
				options: [
					{
						id: 'value',
						label: 'Autoplay',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/autoplay', Number(event.options.value)]),
			},
			[Action.SetSafeMode]: {
				name: 'Set Safe Mode',
				options: [
					{
						id: 'value',
						label: 'Safe Mode',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/safeMode', Number(event.options.value)]),
			},
			[Action.SetAlwaysStopOnSongEnd]: {
				name: 'Set Always Stop on Song End',
				options: [
					{
						id: 'value',
						label: 'Always Stop on Song End',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/alwaysStopOnSongEnd', Number(event.options.value)]),
			},
			[Action.SetAutoJumpToNextSong]: {
				name: 'Set Autojump to the Next Song',
				options: [
					{
						id: 'value',
						label: 'Autojump to the Next Song',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/autoJumpToNextSong', Number(event.options.value)]),
			},
			[Action.SetAutoLoopCurrentSection]: {
				name: 'Set Autoloop the Current Section',
				options: [
					{
						id: 'value',
						label: 'Autoloop the Current Section',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/autoLoopCurrentSection', Number(event.options.value)]),
			},
			[Action.SetCountIn]: {
				name: 'Set Count-In',
				options: [
					{
						id: 'value',
						label: 'Count-In Enabled',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/countIn', Number(event.options.value)]),
			},
			[Action.SetCountInSoloClick]: {
				name: 'Set Solo Click During Count-In',
				options: [
					{
						id: 'value',
						label: 'Solo Click During Count-In',
						type: 'checkbox',
						default: true,
					},
				],
				callback: async (event) => this.sendOsc(['/settings/countInSoloClick', Number(event.options.value)]),
			},
			[Action.SetCountInDuration]: {
				name: 'Set Count-In Duration',
				options: [
					{
						id: 'value',
						label: 'Count-In Duration',
						type: 'dropdown',
						choices: [
							{ id: '1', label: '1 Bar' },
							{ id: '2', label: '2 Bars' },
							{ id: '4', label: '4 Bars' },
						],
						default: '1',
					},
				],
				callback: async (event) => this.sendOsc(['/settings/countInDuration', Number(event.options.value)]),
			},
			[Action.SetJumpMode]: {
				name: 'Set Jump Mode',
				options: [
					{
						id: 'value',
						label: 'Jump Mode',
						type: 'dropdown',
						choices: [
							{ id: 'quantized', label: 'Quantized' },
							{ id: 'end-of-section', label: 'End of Section' },
							{ id: 'end-of-song', label: 'End of Song' },
							{ id: 'manual', label: 'Manual' },
						],
						default: 'quantized',
					},
				],
				callback: async (event) => this.sendOsc(['/settings/jumpMode', String(event.options.value)]),
			},
			//#endregion
		})
	}

	updateVariableDefinitions() {
		this.setVariableDefinitions([
			{ variableId: 'beatsPosition', name: 'Playhead Position in Beats' },
			{ variableId: 'humanPosition', name: 'Playhead Position in Bars.Beats' },
			{ variableId: 'tempo', name: 'Current Tempo' },
			{ variableId: 'isPlaying', name: 'Is Playing' },
			{ variableId: 'timeSignature', name: 'Time Signature' },

			{ variableId: 'setlistName', name: 'Setlist Name' },
			{ variableId: 'activeSongName', name: 'Active Song Name' },
			{ variableId: 'activeSongIndex', name: 'Active Song Index' },
			{ variableId: 'queuedSongName', name: 'Queued Song Name' },
			{ variableId: 'queuedSongIndex', name: 'Queued Song Index' },

			// { variableId: 'activeSongColor', name: 'Active Song Color' },
			{ variableId: 'activeSectionName', name: 'Active Section Name' },
			{ variableId: 'activeSectionIndex', name: 'Active Section Index' },
			{ variableId: 'queuedSectionName', name: 'Queued Section Name' },
			{ variableId: 'queuedSectionIndex', name: 'Queued Section Index' },
			// { variableId: 'activeSectionColor', name: 'Active Section Color' },
			{ variableId: 'nextSongName', name: 'Next Song Name' },
			{ variableId: 'nextSongIndex', name: 'Next Song Index' },
			// { variableId: 'nextSongColor', name: 'Next Song Color' },

			...Array(PRESET_COUNT)
				.fill(0)
				.map((_, i) => ({ variableId: `song${i + 1}Name`, name: `Song ${i + 1} Name` })),
			...Array(PRESET_COUNT)
				.fill(0)
				.map((_, i) => ({ variableId: `section${i + 1}Name`, name: `Section ${i + 1} Name` })),

			{ variableId: 'loopEnabled', name: 'Loop Enabled' },
			{ variableId: 'loopStart', name: 'Loop Start' },
			{ variableId: 'loopEnd', name: 'Loop End' },
			{ variableId: 'isCountingIn', name: 'Is Counting In' },

			{ variableId: 'playAudio12Connected', name: 'PlayAUDIO12 Connected' },
			{ variableId: 'playAudio12Scene', name: 'PlayAUDIO12 Scene' },

			{ variableId: 'autoplay', name: 'Autoplay' },
			{ variableId: 'safeMode', name: 'Safe Mode' },
			{ variableId: 'alwaysStopOnSongEnd', name: 'Always Stop on Song End' },
			{ variableId: 'autoJumpToNextSong', name: 'Autojump to the Next Song' },
			{ variableId: 'autoLoopCurrentSection', name: 'Autoloop the Current Section' },
			{ variableId: 'countIn', name: 'Count-In' },
			{ variableId: 'countInSoloClick', name: 'Solo Click During Count-In' },
			{ variableId: 'countInDuration', name: 'Count-In Duration' },
			{ variableId: 'jumpMode', name: 'Jump Mode' },
		])
	}

	updateFeedbacks() {
		this.setFeedbackDefinitions({
			[Feedback.IsPlaying]: {
				type: 'boolean',
				name: 'Playing',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => {
					return Boolean(this.getVariableValue('isPlaying'))
				},
				options: [],
			},

			[Feedback.IsInLoop]: {
				type: 'boolean',
				name: 'Is in Loop',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => {
					const pos = Number(this.getVariableValue('beatsPosition'))
					return pos >= Number(this.getVariableValue('loopStart')) && pos <= Number(this.getVariableValue('loopEnd'))
				},
				options: [],
			},

			[Feedback.IsInActiveLoop]: {
				type: 'boolean',
				name: 'Is in Active Loop',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => this.isInActiveLoop(),
				options: [],
			},

			[Feedback.IsCurrentSong]: {
				type: 'boolean',
				name: 'Is Current Song',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: (feedback) => {
					return Number(this.getVariableValue('activeSongIndex')) === Number(feedback.options.songNumber) - 1
				},
				options: [
					{
						id: 'songNumber',
						label: 'Song Number',
						type: 'number',
						min: 1,
						max: 100,
						default: 1,
					},
				],
			},

			[Feedback.IsCurrentSection]: {
				type: 'boolean',
				name: 'Is Current Section',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: (feedback) => {
					return Number(this.getVariableValue('activeSectionIndex')) === Number(feedback.options.sectionNumber) - 1
				},
				options: [
					{
						id: 'sectionNumber',
						label: 'Section Number',
						type: 'number',
						min: 1,
						max: 100,
						default: 1,
					},
				],
			},

			[Feedback.IsQueuedSong]: {
				type: 'boolean',
				name: 'Is Queued Song',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: (feedback) => {
					return (
						this.getVariableValue('queuedSongIndex') !== '' &&
						Number(this.getVariableValue('queuedSongIndex')) === Number(feedback.options.songNumber) - 1
					)
				},
				options: [
					{
						id: 'songNumber',
						label: 'Song Number',
						type: 'number',
						min: 1,
						max: 100,
						default: 1,
					},
				],
			},

			[Feedback.IsQueuedSection]: {
				type: 'boolean',
				name: 'Is Queued Section',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: (feedback) => {
					return (
						this.getVariableValue('queuedSectionIndex') !== '' &&
						Number(this.getVariableValue('queuedSectionIndex')) === Number(feedback.options.sectionNumber) - 1
					)
				},
				options: [
					{
						id: 'sectionNumber',
						label: 'Section Number',
						type: 'number',
						min: 1,
						max: 100,
						default: 1,
					},
				],
			},

			[Feedback.CanJumpToNextSong]: {
				type: 'boolean',
				name: 'Can Jump to Next Song',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => {
					return Number(this.getVariableValue('activeSongIndex')) < this.songs.length - 1
				},
				options: [],
			},

			[Feedback.CanJumpToPreviousSong]: {
				type: 'boolean',
				name: 'Can Jump to Previous Song',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => {
					return Number(this.getVariableValue('activeSongIndex')) > 0
				},
				options: [],
			},

			[Feedback.CanJumpToNextSection]: {
				type: 'boolean',
				name: 'Can Jump to Next Section',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => {
					return Number(this.getVariableValue('activeSectionIndex')) < this.sections.length - 1
				},
				options: [],
			},

			[Feedback.CanJumpToPreviousSection]: {
				type: 'boolean',
				name: 'Can Jump to Previous Section',
				defaultStyle: { bgcolor: COLOR_GREEN_500 },
				callback: () => {
					return Number(this.getVariableValue('activeSectionIndex')) > 0
				},
				options: [],
			},
		})
	}

	updatePresets() {
		const defaultSongStyle = { bgcolor: COLOR_BLACK, color: COLOR_WHITE, size: '14' } as const
		const defaultStyle = { bgcolor: COLOR_BLACK, color: COLOR_WHITE, size: '18' } as const

		const songPresets = Object.fromEntries(
			makeRange(PRESET_COUNT).map((i) => [
				`song${i + 1}`,
				{
					category: 'Songs',
					name: `Song ${i + 1}`,
					type: 'button',
					previewStyle: { ...defaultSongStyle, text: `Song ${i + 1}` },
					style: { ...defaultSongStyle, text: `$(AbleSet:song${i + 1}Name)` },
					steps: [{ down: [{ actionId: Action.JumpToSongByNumber, options: { number: i + 1 } }], up: [] }],
					feedbacks: [
						{
							feedbackId: Feedback.IsQueuedSong,
							options: { songNumber: i + 1 },
							style: { bgcolor: COLOR_GREEN_800 },
						},
						{
							feedbackId: Feedback.IsCurrentSong,
							options: { songNumber: i + 1 },
							style: { bgcolor: COLOR_GREEN_500 },
						},
					],
				} as CompanionButtonPresetDefinition,
			])
		)

		const sectionPresets = Object.fromEntries(
			makeRange(PRESET_COUNT).map((i) => [
				`section${i + 1}`,
				{
					category: 'Sections',
					name: `Section ${i + 1}`,
					type: 'button',
					previewStyle: { ...defaultSongStyle, text: `Section ${i + 1}` },
					style: { ...defaultSongStyle, text: `$(AbleSet:section${i + 1}Name)` },
					steps: [{ down: [{ actionId: Action.JumpToSectionByNumber, options: { number: i + 1 } }], up: [] }],
					feedbacks: [
						{
							feedbackId: Feedback.IsQueuedSection,
							options: { sectionNumber: i + 1 },
							style: { bgcolor: COLOR_GREEN_800 },
						},
						{
							feedbackId: Feedback.IsCurrentSection,
							options: { sectionNumber: i + 1 },
							style: { bgcolor: COLOR_GREEN_500 },
						},
					],
				} as CompanionButtonPresetDefinition,
			])
		)

		const playbackPresets: CompanionPresetDefinitions = {
			playPause: {
				category: 'Playback',
				name: 'Toggle Play/Pause',
				type: 'button',
				style: { ...defaultStyle, text: '', png64: PLAY_ICON },
				steps: [{ down: [{ actionId: Action.PlayPause, options: {} }], up: [] }],
				feedbacks: [
					{
						feedbackId: Feedback.IsPlaying,
						options: {},
						style: { bgcolor: COLOR_GREEN_700, png64: PAUSE_ICON_GREEN },
					},
				],
			},
			playStop: {
				category: 'Playback',
				name: 'Toggle Play/Stop',
				type: 'button',
				style: { ...defaultStyle, text: '', png64: PLAY_ICON },
				steps: [{ down: [{ actionId: Action.PlayStop, options: {} }], up: [] }],
				feedbacks: [
					{
						feedbackId: Feedback.IsPlaying,
						options: {},
						style: { bgcolor: COLOR_GREEN_700, png64: STOP_ICON_GREEN },
					},
				],
			},
			prevSong: {
				category: 'Playback',
				name: 'Previous Song',
				type: 'button',
				style: { ...defaultStyle, color: COLOR_GRAY, text: '<\nSong' },
				steps: [{ down: [{ actionId: Action.JumpBySongs, options: { steps: -1 } }], up: [] }],
				feedbacks: [{ feedbackId: Feedback.CanJumpToPreviousSong, options: {}, style: { color: COLOR_WHITE } }],
			},
			nextSong: {
				category: 'Playback',
				name: 'Next Song',
				type: 'button',
				style: { ...defaultStyle, color: COLOR_GRAY, text: '>\nSong' },
				steps: [{ down: [{ actionId: Action.JumpBySongs, options: { steps: 1 } }], up: [] }],
				feedbacks: [{ feedbackId: Feedback.CanJumpToNextSong, options: {}, style: { color: COLOR_WHITE } }],
			},
			prevSection: {
				category: 'Playback',
				name: 'Previous Section',
				type: 'button',
				style: { ...defaultStyle, color: COLOR_GRAY, text: '<\nSection' },
				steps: [{ down: [{ actionId: Action.JumpBySections, options: { steps: -1 } }], up: [] }],
				feedbacks: [{ feedbackId: Feedback.CanJumpToPreviousSection, options: {}, style: { color: COLOR_WHITE } }],
			},
			nextSection: {
				category: 'Playback',
				name: 'Next Section',
				type: 'button',
				style: { ...defaultStyle, color: COLOR_GRAY, text: '>\nSection' },
				steps: [{ down: [{ actionId: Action.JumpBySections, options: { steps: 1 } }], up: [] }],
				feedbacks: [{ feedbackId: Feedback.CanJumpToNextSection, options: {}, style: { color: COLOR_WHITE } }],
			},
			toggleLoop: {
				category: 'Playback',
				name: 'Toggle Loop',
				type: 'button',
				style: { ...defaultStyle, color: COLOR_GRAY, text: '', png64: LOOP_ICON_GRAY },
				steps: [{ down: [{ actionId: Action.ToggleLoop, options: {} }], up: [] }],
				feedbacks: [
					{ feedbackId: Feedback.IsInLoop, options: {}, style: { png64: LOOP_ICON } },
					{
						feedbackId: Feedback.IsInActiveLoop,
						options: {},
						style: { bgcolor: COLOR_GREEN_700, png64: LOOP_ICON_GREEN },
					},
				],
			},
		}

		this.setPresetDefinitions({ ...songPresets, ...sectionPresets, ...playbackPresets })
	}
}

runEntrypoint(ModuleInstance, [])