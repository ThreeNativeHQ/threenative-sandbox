/** Asset delivery contract: new rigs, real moving parts, preserved spans and supported materials. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AnimationMixer,Box3,Vector3,LoopOnce} from 'three';
import {checkHumanoid,loadGlb} from './check-humanoid.mjs';
const path=name=>new URL('../assets/'+name,import.meta.url);
for(const [file,height,clips] of [['carrier-aircraft-pilot.glb',1.78,['gesture','idle','sit','walk']],['flight-deck-director.glb',1.8,['idle','walk','gesture']]])
 checkHumanoid(await loadGlb(path(file)),{clips,height,hands:'rigid'});
checkHumanoid(await loadGlb(path('deck-crew.glb')),{clips:['crew.chock','crew.idle','crew.service','crew.signal','crew.wait','crew.walk'],height:1.83,minimumHandVertices:50,minimumFingerVertices:10});
const clips=['propeller.spin','gear.retract','flaps.deploy','flight.pitch-up','flight.pitch-down','flight.roll-left','flight.roll-right','flight.rudder-left','flight.rudder-right'];
for(const [file,span] of [['aircraft.tbd-devastator.glb',15.24],['aircraft.tbd-devastator.ai.glb',15.24],['aircraft.b5n2-kate.glb',15.52]]){
 const g=await loadGlb(path(file));g.scene.updateMatrixWorld(true);
 assert(Math.abs(new Box3().setFromObject(g.scene).getSize(new Vector3()).x-span)<.02,file+' changed wingspan');
 assert.deepEqual(g.animations.map(c=>c.name).sort(),[...clips].sort());
 assert(g.scene.getObjectByName('propeller').getWorldPosition(new Vector3()).z<0,file+' wrong nose direction');
 const body=g.scene.getObjectByName('airframebody');assert(body?.userData.sourceProportionsPreserved,file+' missing source transform contract');
 const rest=body.matrixWorld.clone(),mixer=new AnimationMixer(g.scene);
 for(const clip of g.animations){
  mixer.stopAllAction();g.scene.updateMatrixWorld(true);
  const before=new Map();g.scene.traverse(n=>before.set(n.uuid,n.matrixWorld.clone()));
  const action=mixer.clipAction(clip);action.setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
  mixer.setTime(clip.duration*.65);g.scene.updateMatrixWorld(true);
  let changed=false;g.scene.traverse(n=>{if(!n.matrixWorld.equals(before.get(n.uuid)))changed=true});
  assert(changed,file+' '+clip.name+' has no motion');assert(body.matrixWorld.equals(rest),file+' '+clip.name+' moves fuselage');
 }
 console.log(file+': span, nose, nine moving clips, fixed fuselage PASS');
}
const bytes=await readFile(path('boat.pt59.glb'));const j=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)));
assert(!j.extensionsUsed.includes('KHR_materials_pbrSpecularGlossiness'),'PT59 needs material conversion');
assert(j.meshes.length>0&&j.images.length>0,'PT59 lost source content');
console.log('PASS asset-polish');
