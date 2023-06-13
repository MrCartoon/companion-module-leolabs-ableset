/** Available feedbacks */
export const enum Feedback {
	IsPlaying = 'isPlaying',
	IsInLoop = 'isInLoop',
	IsInActiveLoop = 'isInActiveLoop',
	IsCurrentSong = 'isCurrentSong',
	IsCurrentSection = 'isCurrentSection',
	IsQueuedSong = 'isQueuedSong',
	IsQueuedSection = 'isQueuedSection',
	CanJumpToNextSong = 'canJumpToNextSong',
	CanJumpToPreviousSong = 'canJumpToPreviousSong',
	CanJumpToNextSection = 'canJumpToNextSection',
	CanJumpToPreviousSection = 'canJumpToPreviousSection',
}

/** Available actions */
export const enum Action {
	Play = 'play',
	Pause = 'pause',
	Stop = 'stop',
	PlayPause = 'playPause',
	PlayStop = 'playStop',
	EnableLoop = 'enableLoop',
	EscapeLoop = 'escapeLoop',
	ToggleLoop = 'toggleLoop',
	JumpToSongByNumber = 'jumpToSongByNumber',
	JumpToSongByName = 'jumpToSongByName',
	JumpBySongs = 'jumpBySongs',
	JumpToSectionByNumber = 'jumpToSectionByNumber',
	JumpToSectionByName = 'jumpToSectionByName',
	JumpBySections = 'jumpBySections',
	PlayCuedSong = 'playCuedSong',
	Pa12SetScene = 'pa12SetScene',
	Pa12ToggleScene = 'pa12ToggleScene',
	SetAutoplay = 'setAutoplay',
	SetSafeMode = 'setSafeMode',
	SetAlwaysStopOnSongEnd = 'setAlwaysStopOnSongEnd',
	SetAutoJumpToNextSong = 'setAutoJumpToNextSong',
	SetAutoLoopCurrentSection = 'setAutoLoopCurrentSection',
	SetCountIn = 'setCountIn',
	SetCountInSoloClick = 'setCountInSoloClick',
	SetCountInDuration = 'setCountInDuration',
	SetJumpMode = 'setJumpMode',
}