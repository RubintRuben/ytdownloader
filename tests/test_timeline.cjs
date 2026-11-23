const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('static/app.js','utf8');
const fn = source.slice(source.indexOf('function updateTimelineDuration('), source.indexOf('function releaseFrameSampler('));
function fixture(values={}) {
  const removed=[];
  const c={duration:0, selStart:0, selEnd:0, info:{}, pendingSelection:null,
    editor:{classList:{remove(...names){removed.push(...names);}}}, trimBlock:{hidden:true},
    timeline:{setAttribute(){}},totTimeEl:{},layoutWindow(){},scheduleEstimate(){},fmtTime:String, ...values};
  vm.createContext(c);vm.runInContext(fn,c);return {c,removed};
}
{
  const {c,removed}=fixture();c.updateTimelineDuration(10.17);
  assert.equal(c.duration,10.17);assert.equal(c.selEnd,10.17);assert.equal(c.trimBlock.hidden,false);
  assert.ok(removed.includes('timeline-pending'));assert.equal(c.info.duration,10.17);
}
{
  const {c}=fixture({duration:10,selStart:2,selEnd:7});c.updateTimelineDuration(10.17);
  assert.equal(c.selStart,2);assert.equal(c.selEnd,7);
}
{
  const {c}=fixture({pendingSelection:{start:2,end:5}});c.updateTimelineDuration(10.17);
  assert.equal(c.selStart,2);assert.equal(c.selEnd,5);assert.equal(c.pendingSelection,null);
}
{
  const {c}=fixture();c.updateTimelineDuration(Infinity);assert.equal(c.duration,0);
  c.updateTimelineDuration(.4);assert.equal(c.selEnd,.4);
}
console.log('PASS: missing duration, preserved cuts, saved cuts, short clips and non-finite durations');

const format = source.slice(source.indexOf('function fmtTime('), source.indexOf('function fmtSize('));
const playback = source.slice(source.indexOf('function renderPlayhead('), source.indexOf('function followPlaybackFrame('));
{
  const video = {currentTime: 0, duration: 12, readyState: 4, seeking: false, paused: true};
  const context = {
    igVideo: video, info: {}, duration: 12, selStart: 3.4, selEnd: 5.5, previewWantPlay: false,
    previewGeneration: 1, pendingPreviewSeek: null, drag: null,
    playhead: {style: {}}, curTimeEl: {}, phBubble: {}, setPlayIcon() {},
    seekTo(time) { video.currentTime = time; video.seeking = true; return true; },
  };
  video.play = async () => { video.paused = false; };
  video.pause = () => { video.paused = true; };
  vm.createContext(context);
  vm.runInContext(format + playback, context);
  assert.equal(context.fmtTrimTime(3.4), '0:03,40');
  assert.equal(context.fmtTrimTime(59.999), '1:00,00');

  context.playSelectedRange();
  assert.equal(video.currentTime, 3.4);
  assert.equal(video.paused, true);
  assert.equal(context.previewWantPlay, true);
  video.seeking = false;
  context.playSelectedRange();
  assert.equal(video.paused, false);
  assert.equal(context.previewWantPlay, false);

  video.currentTime = 5.499;
  context.checkPlaybackPosition();
  assert.equal(video.currentTime, 5.5);
  assert.equal(video.paused, true);
}
console.log('PASS: trim labels round correctly and playback stays within the selection');
