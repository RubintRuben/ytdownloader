// Exercise batch failure retention using the actual frontend function in a small fixture.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('static/app.js', 'utf8');
const batch = source.slice(source.indexOf('async function downloadSelected()'), source.indexOf('// --- lista-panel nyit/zár'));
const notice = {};
const items = [{id:'ok',title:'First'}, {id:'fail',title:'Second'}, {id:'ok2',title:'Third'}];
const context = { listBusy:false, downloadList:items, listSelected:new Set(items.map(x=>x.id)), editingListId:null,
  updateListSelectionUI(){}, $:()=>notice, paramsFromListItem:x=>x,
  prepareJob:async x=>{ if(x.id==='fail') throw Error('Unavailable'); },
  startJobPolling(){},updateEditorListButtons(){},persistList(){},renderList(){},
  closeList(){throw Error('Failed items must remain visible');},openJobs(){} };
vm.createContext(context);
vm.runInContext(batch, context);
(async()=>{
  await context.downloadSelected();
  assert.deepEqual(context.downloadList.map(x=>x.id), ['fail']);
  assert.deepEqual([...context.listSelected], ['fail']);
  assert.equal(context.listBusy, false);
  assert.match(notice.textContent, /Second: Unavailable/);
  console.log('PASS: batch partial failure retains failed item and selection');
})().catch(error=>{console.error(error);process.exitCode=1;});
