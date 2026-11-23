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
