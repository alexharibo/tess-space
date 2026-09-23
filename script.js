/* ---------- nav scroll state ---------- */
const header = document.getElementById('siteHeader');
window.addEventListener('scroll', () => {
  header.classList.toggle('scrolled', window.scrollY > 30);
}, {passive:true});

/* ---------- reveal on view ---------- */
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('in'); });
}, {threshold:0.15});
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

/* ---------- GLOBE ---------- */
(function(){
  const canvas = document.getElementById('globeCanvas');
  const ctx = canvas.getContext('2d');
  let W=0,H=0,DPR=Math.min(window.devicePixelRatio||1,2);

  function resize(){
    const rect = canvas.parentElement.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W*DPR; canvas.height = H*DPR;
    canvas.style.width = W+'px'; canvas.style.height = H+'px';
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ---- rough continent test (stylized, not survey-accurate) ---- */
  function inPoly(lat, lon, poly){
    let inside=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const yi=poly[i][0], xi=poly[i][1], yj=poly[j][0], xj=poly[j][1];
      const intersect = ((yi>lat)!==(yj>lat)) && (lon < (xj-xi)*(lat-yi)/((yj-yi)||1e-9)+xi);
      if(intersect) inside=!inside;
    }
    return inside;
  }
  const NA=[[70,-165],[70,-90],[58,-65],[47,-52],[43,-66],[30,-81],[25,-97],[18,-97],[16,-90],[32,-117],[40,-124],[49,-125],[60,-140],[70,-165]];
  const SA=[[12,-72],[10,-61],[-2,-35],[-23,-43],[-34,-58],[-55,-68],[-42,-73],[-18,-70],[-4,-81],[5,-77],[12,-72]];
  const EU=[[71,26],[64,32],[55,38],[47,40],[41,29],[36,15],[38,-3],[43,-9],[51,-5],[58,6],[63,10],[70,20],[71,26]];
  const AF=[[37,10],[32,33],[12,44],[-1,42],[-26,33],[-35,20],[-22,12],[-4,9],[5,-9],[15,-17],[31,-10],[37,10]];
  const AU=[[-11,131],[-13,143],[-19,147],[-27,153],[-38,147],[-35,138],[-32,115],[-21,114],[-14,126],[-11,131]];
  const boxes=[ // rough asia blocks: [latMin,latMax,lonMin,lonMax,weight]
    [45,72,35,180,0.5],   // siberia/russia
    [12,45,42,62,0.55],   // middle east
    [6,34,68,90,0.75],    // india
    [20,53,95,135,0.85],  // china/east asia
    [30,46,128,146,0.9],  // japan/korea
    [-10,20,95,142,0.55], // SE asia
  ];
  function isLand(lat,lon){
    if(inPoly(lat,lon,NA))return 0.55;
    if(inPoly(lat,lon,SA))return 0.4;
    if(inPoly(lat,lon,EU))return 1.0;
    if(inPoly(lat,lon,AF))return 0.35;
    if(inPoly(lat,lon,AU))return 0.4;
    for(const b of boxes){ if(lat>=b[0]&&lat<=b[1]&&lon>=b[2]&&lon<=b[3]) return b[4]; }
    return 0;
  }

  // build point cloud once
  const points=[];
  for(let lat=-80; lat<=82; lat+=2.1){
    const stepLon = 2.1/Math.max(0.18,Math.cos(lat*Math.PI/180));
    for(let lon=-180; lon<180; lon+=stepLon){
      const w = isLand(lat,lon);
      if(w<=0) continue;
      if(Math.random() > Math.min(1,0.55*w+0.4)) continue; // sparsify (denser than before)
      const bright = Math.random() < (0.32*w+0.06); // more points read as bright "cities"
      points.push({lat, lon:lon, bright, w});
    }
  }
  // satellites
  const sats = Array.from({length:5}).map((_,i)=>({
    inc: (Math.random()*40-20),
    speed: 0.15+Math.random()*0.25,
    offset: Math.random()*Math.PI*2,
    r: 1.28+Math.random()*0.22
  }));

  let rotY = 0.4;      // current rotation
  let autoSpeed = 0.0011;
  let lastScrollY = window.scrollY;
  let visible = true;

  window.addEventListener('scroll', () => {
    const dy = window.scrollY - lastScrollY;
    rotY += dy * 0.0028;
    lastScrollY = window.scrollY;
  }, {passive:true});

  const holder = canvas.parentElement;
  const vio = new IntersectionObserver(es=>{ es.forEach(e=>{visible=e.isIntersecting;}); }, {threshold:0});
  vio.observe(holder);

  function project(lat, lon, ry, R, cx, cy){
    const la = lat*Math.PI/180;
    const lo = lon*Math.PI/180 + ry;
    const x = Math.cos(la)*Math.sin(lo);
    const y = Math.sin(la);
    const z = Math.cos(la)*Math.cos(lo);
    return { x: cx + x*R, y: cy - y*R, z, sx:x, sy:y };
  }

  function draw(t){
    if(!visible){ requestAnimationFrame(draw); return; }
    rotY += autoSpeed;
    ctx.clearRect(0,0,W,H);

    const R = Math.min(W,H)*0.42;
    const cx = W*0.5, cy = H*0.5;

    // atmosphere glow
    const g = ctx.createRadialGradient(cx,cy,R*0.96,cx,cy,R*1.28);
    g.addColorStop(0,'rgba(90,150,255,0.35)');
    g.addColorStop(1,'rgba(90,150,255,0)');


    // sphere body
    const bg = ctx.createRadialGradient(cx-R*0.35,cy-R*0.35,R*0.1,cx,cy,R*1.05);
    bg.addColorStop(0,'#12212f');
    bg.addColorStop(0.55,'#050b12');
    bg.addColorStop(1,'#000103');
    ctx.fillStyle=bg;
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();

    // rim light
    ctx.save();
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.clip();
    const rim = ctx.createLinearGradient(cx-R,cy-R,cx+R*0.2,cy+R*0.2);
    rim.addColorStop(0,'rgba(120,180,255,0.55)');
    rim.addColorStop(0.25,'rgba(120,180,255,0)');
    ctx.fillStyle=rim;
    ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();
    ctx.restore();

    // land / city points
    for(const p of points){
      const pr = project(p.lat,p.lon,rotY,R,cx,cy);
      if(pr.z <= -0.05) continue;
      const depth = Math.max(0,pr.z);
      const size = p.bright ? (1.2+depth*1.7) : (0.7+depth*1.0);
      const alpha = (p.bright? 0.6:0.35) + depth*0.5;
      ctx.beginPath();
      ctx.fillStyle = p.bright ? `rgba(255,150,65,${Math.min(alpha,1)})` : `rgba(140,165,195,${Math.min(alpha*0.65,0.68)})`;
      ctx.arc(pr.x, pr.y, size, 0, Math.PI*2);
      ctx.fill();
    }



    
    // satellites + orbit rings
    sats.forEach(s=>{
      const ang = t*0.0002*s.speed*60 + s.offset;
      const incRad = s.inc*Math.PI/180;
      const ox = Math.cos(ang)*R*s.r;
      const oy = Math.sin(ang)*R*s.r*Math.sin(incRad+0.6);
      const oz = Math.sin(ang)*Math.cos(incRad+0.6);
      const sx = cx+ox, sy = cy+oy*0.6 - R*0.02;
      const op = oz>0? 0.85:0.25;
      ctx.beginPath();
      ctx.fillStyle = `rgba(255,255,255,${op})`;
      ctx.arc(sx,sy,1.6,0,Math.PI*2);
      ctx.fill();
    });

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();

(function(){
  const track = document.getElementById('sensingTrack');
  const dots = document.querySelectorAll('#sensingDots .sensing-dot');
  if(!track || !dots.length) return;

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      const i = parseInt(dot.dataset.i, 10);
      const card = track.children[i];
      if(card) track.scrollTo({ left: card.offsetLeft - 0, behavior: 'smooth' });
    });
  });

  let ticking = false;
  track.addEventListener('scroll', () => {
    if(ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const cards = Array.from(track.children);
      let closest = 0, minDist = Infinity;
      cards.forEach((card, i) => {
        const dist = Math.abs(card.offsetLeft - track.scrollLeft);
        if(dist < minDist){ minDist = dist; closest = i; }
      });
      dots.forEach((d, i) => d.classList.toggle('active', i === closest));
      ticking = false;
    });
  }, {passive:true});
})();