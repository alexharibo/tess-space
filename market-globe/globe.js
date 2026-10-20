
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js';
const root=document.getElementById('globe');
const scene=new THREE.Scene(); scene.background=new THREE.Color('#000000');
const camera=new THREE.PerspectiveCamera(36,1,.1,100);
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
renderer.outputColorSpace=THREE.SRGBColorSpace;
root.appendChild(renderer.domElement);
const globe=new THREE.Group();scene.add(globe);
const texture=new THREE.TextureLoader().load('./assets/earth-map-polar-borders.png');
texture.colorSpace=THREE.SRGBColorSpace; texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const earth=new THREE.Mesh(new THREE.SphereGeometry(1,96,64),new THREE.MeshBasicMaterial({map:texture}));globe.add(earth);
function point(lat,lon,r=1.006){const p=(90-lat)*Math.PI/180,t=(lon+180)*Math.PI/180;return new THREE.Vector3(-r*Math.sin(p)*Math.cos(t),r*Math.cos(p),r*Math.sin(p)*Math.sin(t))}
// V2.9: No city lights. Thin TESS Orange (#FF7900) borders in Europe, preserved Arctic white.
// Rotation, camera zoom, satellites and page layout unchanged.
// Six silhouettes. Physical orbital depth hides satellites behind Earth automatically.
function satellite(size,opacity){const g=new THREE.Group();const m=new THREE.MeshBasicMaterial({color:0x9da0a4,transparent:true,opacity,side:THREE.DoubleSide,depthTest:true});
const body=new THREE.Mesh(new THREE.BoxGeometry(.055,.042,.042),m);g.add(body);
for(const s of [-1,1]){const p=new THREE.Mesh(new THREE.BoxGeometry(.105,.003,.061),m);p.position.x=s*.102;g.add(p)}g.scale.setScalar(size);scene.add(g);return g;}
const satellites=[satellite(1.1,.7),satellite(.42,.6),...Array.from({length:4},()=>satellite(.105,.5))];
// Smooth cyclic Hermite interpolation with nonzero, continuous velocity at the loop boundary.
// Longitude is intentionally routed westward from Europe across Greenland back to America.
const keys=[
{t:0,lat:40,lon:-101,d:4.25},
{t:8,lat:43,lon:-66,d:4.23},
{t:17,lat:53,lon:-12,d:4.10},
{t:27,lat:55,lon:10,d:3.22},
{t:36,lat:56,lon:8,d:3.22},
{t:44,lat:67,lon:-41,d:4.06},
{t:53,lat:53,lon:-75,d:4.23},
{t:60,lat:40,lon:-101,d:4.25}];
function hermite(a,b,ma,mb,u,dt){let u2=u*u,u3=u2*u;return (2*u3-3*u2+1)*a+(u3-2*u2+u)*ma*dt+(-2*u3+3*u2)*b+(u3-u2)*mb*dt}
function tangent(i,field){const n=keys.length-1; if(i===0||i===n){return (keys[1][field]-keys[0][field])/(keys[1].t-keys[0].t)*.55+(keys[n][field]-keys[n-1][field])/(keys[n].t-keys[n-1].t)*.45;}return (keys[i+1][field]-keys[i-1][field])/(keys[i+1].t-keys[i-1].t)}
function frame(sec){let i=0;while(i<keys.length-2&&sec>=keys[i+1].t)i++;const a=keys[i],b=keys[i+1],dt=b.t-a.t,u=(sec-a.t)/dt;return {lat:hermite(a.lat,b.lat,tangent(i,'lat'),tangent(i+1,'lat'),u,dt),lon:hermite(a.lon,b.lon,tangent(i,'lon'),tangent(i+1,'lon'),u,dt),d:hermite(a.d,b.d,tangent(i,'d'),tangent(i+1,'d'),u,dt)}}
function update(time){const t=((time%60)+60)%60,f=frame(t);camera.position.copy(point(f.lat,f.lon,f.d));camera.up.set(0,1,0);camera.lookAt(0,0,0);
// Foreground orbit: size is reduced fivefold when behind the Earth.
const ang=t*2*Math.PI/60+.6;
const s0=satellites[0];s0.position.set(1.5*Math.cos(ang),.65*Math.sin(ang),1.5*Math.sin(ang));s0.rotation.set(.35,ang+.5,.2);
const forward=new THREE.Vector3().copy(camera.position).normalize();const behind=s0.position.dot(forward)<0;
s0.scale.setScalar(behind?.22:1.1);
const s1=satellites[1],a1=t*2*Math.PI/30+1.6;s1.position.set(1.15*Math.cos(a1),.25*Math.sin(a1),1.15*Math.sin(a1));s1.rotation.set(.4,a1,.2);
for(let i=2;i<6;i++){const s=satellites[i],k=i-2,a=t*2*Math.PI/[20,30,60,15][k]+k*1.4,inc=[.3,.75,1.1,1.35][k];const r=1.16+k*.055;s.position.set(r*Math.cos(a),r*Math.sin(a)*Math.sin(inc),r*Math.sin(a)*Math.cos(inc));s.rotation.set(inc,a,.2);}
}
function resize(){const w=root.clientWidth,h=root.clientHeight;if(!w||!h)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h,false)}
new ResizeObserver(resize).observe(root);resize();
let visible=true;new IntersectionObserver(entries=>{visible=entries[0].isIntersecting}).observe(root);
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const start=performance.now();
function animate(now){requestAnimationFrame(animate);if(!visible)return;update(reduced?30:(now-start)/1000);renderer.render(scene,camera)}requestAnimationFrame(animate);


