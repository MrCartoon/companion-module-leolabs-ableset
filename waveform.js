const fs = require('fs')
const wav = require('node-wav')
const { DOMParser } = require('xmldom')
const xpath = require('xpath')
const { execSync } = require('child_process')
const { escape } = require('shell-escape-tag');

function readWavFile(filePath, startMs, endMs) {
	const buffer = fs.readFileSync(filePath)
	const result = wav.decode(buffer)
	const sampleRate = result.sampleRate
	const startSample = Math.floor((startMs / 1000) * sampleRate)
	const endSample = Math.floor((endMs / 1000) * sampleRate)
	const slicedData = result.channelData[0].slice(startSample, endSample) // Assuming mono audio
	return slicedData
}

function averageToDataPoints(data, resolution) {
	const segmentSize = Math.floor(data.length / resolution)
	const maxData = []
	const minData = []

	for (let i = 0; i < resolution; i++) {
		const segment = data.slice(i * segmentSize, (i + 1) * segmentSize)
		maxData.push(Math.round((Math.max(...segment) * resolution) / 2))
		minData.push(Math.round((Math.min(...segment) * resolution) / 2))
	}

	return { maxData, minData }
}

function main(filePath, startMs, endMs, resolution) {
	const data = readWavFile(filePath, startMs, endMs)
	const { maxData, minData } = averageToDataPoints(data, resolution)
	return [...maxData, ...minData]
}

fs.readdirSync('ableton/').filter(file => file.endsWith('.als')).forEach((alsFile) => {
	const audioPath = `ableton/${alsFile.replace('.als', '.wav')}`
	const alsPath = `ableton/${alsFile}`
	const resolution = 72
	const songSectionWaveforms = []
	const sectoinMs = []

	const gzPath = alsPath.replace('.als', '.xml.gz')
	fs.copyFileSync(alsPath, gzPath)

	const gzPathEscaped = escape([gzPath]);
	const xmlPath = gzPath.replace('.gz', '')
	if (!fs.existsSync(xmlPath)) {
		execSync(`gunzip ${gzPathEscaped}`);
	}
	const xml = fs.readFileSync(xmlPath, 'utf8')

	const doc = new DOMParser().parseFromString(xml)
	const nodes = xpath.select('//MidiClip/Name[@Value="Count"]/../../*', doc)

	const tempo = Number(xmlPath.split('-')[1])
	const speedMs = 60.0 / tempo * 1000

	nodes.forEach(node => {
		if (node.nodeName !== 'MidiClip') return
		const startMs = Math.round(parseFloat(Array.from(xpath.select1('CurrentStart', node).attributes).find(attr => attr.name === 'Value').value) * speedMs)
		const endMs = Math.round(parseFloat(Array.from(xpath.select1('CurrentEnd', node).attributes).find(attr => attr.name === 'Value').value) * speedMs)
		sectoinMs.push([startMs, endMs])
	})

	sectoinMs.forEach(([startMs, endMs], i) => {
		songSectionWaveforms.push([i, ...main(audioPath, startMs, endMs, resolution)])
	})

	const outputPath = `${audioPath.split('-')[0].replace('ableton/', 'waveforms/')}.json`
	fs.writeFileSync(outputPath, JSON.stringify(songSectionWaveforms))
})
