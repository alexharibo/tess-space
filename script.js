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

/* ---------- mission detail modal ---------- */
(function(){
  const panels = Array.from(document.querySelectorAll('.mission-panel'));
  const modal = document.getElementById('missionModal');
  if(!panels.length || !modal) return;

  const mmImg   = modal.querySelector('.mm-media img');
  const mmEye   = modal.querySelector('.mm-eyebrow');
  const mmTitle = modal.querySelector('.mm-title');
  const mmTag   = modal.querySelector('.mm-tagline');
  const mmDesc  = modal.querySelector('.mm-desc');
  const mmMeta  = modal.querySelector('.mm-meta');
  

  let current = 0;

  function render(i){
    current = (i + panels.length) % panels.length;
    const p = panels[current];
    const img = p.querySelector('.mission-media img');
    mmImg.src = img ? img.src : '';
    mmImg.alt = img ? img.alt : '';
    mmEye.textContent = p.querySelector('.eyebrow').textContent;
    mmTitle.textContent = p.querySelector('h3').textContent;
    mmTag.textContent = p.querySelector('.mission-content p').textContent;
    mmDesc.textContent = p.querySelector('.mission-detail').textContent;
    mmMeta.innerHTML = p.querySelector('.mission-meta').innerHTML;
  }

  function open(i){
    render(i);
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function close(){
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }

  panels.forEach((panel, i) => {
    panel.addEventListener('click', (e) => {
      if(e.target.closest('.mission-meta')) return;
      e.preventDefault();
      open(i);
    });
  });

  modal.querySelector('.mm-prev').addEventListener('click', () => render(current - 1));
  modal.querySelector('.mm-next').addEventListener('click', () => render(current + 1));
  modal.querySelector('.mm-close').addEventListener('click', close);
  modal.querySelector('.mm-backdrop').addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if(!modal.classList.contains('open')) return;
    if(e.key === 'Escape') close();
    if(e.key === 'ArrowRight') render(current + 1);
    if(e.key === 'ArrowLeft') render(current - 1);
  });
})();


/* ---------- our story timeline ---------- */
(function(){
  const timeline = document.getElementById('storyTimeline');
  const fill = document.getElementById('storyFill');
  if(!timeline || !fill) return;

  const steps = Array.from(timeline.querySelectorAll('.st-step'));
  let current = 0;

  function render(i){
    current = (i + steps.length) % steps.length;
    steps.forEach((s, idx) => s.classList.toggle('active', idx === current));
    const pct = ((current + 0.5) / steps.length) * 100;
    fill.style.width = pct + '%';
  }

  steps.forEach((step, i) => step.addEventListener('click', () => render(i)));

  const prev = document.querySelector('.story-prev');
  const next = document.querySelector('.story-next');
  if(prev) prev.addEventListener('click', () => render(current - 1));
  if(next) next.addEventListener('click', () => render(current + 1));

  render(0);
})();

document.addEventListener('DOMContentLoaded', () => {
  const teamCards = document.getElementById('teamCards');
  const prevBtn = document.querySelector('.team-prev');
  const nextBtn = document.querySelector('.team-next');
  const cards = document.querySelectorAll('.team-card');

  if (!teamCards || !prevBtn || !nextBtn) return;

  // Hvor meget der scrolles ved tryk på pilene (kort-bredde + gap)
  const scrollAmount = 236; 

  // Pil-navigation (Scroll til venstre / højre)
  nextBtn.addEventListener('click', () => {
    teamCards.scrollBy({ left: scrollAmount, behavior: 'smooth' });
  });

  prevBtn.addEventListener('click', () => {
    teamCards.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
  });

  // Skift det aktive/fremhævede kort ved klik
  cards.forEach(card => {
    card.addEventListener('click', () => {
      // Fjern 'active' fra alle kort
      cards.forEach(c => c.classList.remove('active'));
      
      // Tilføj 'active' til det valgte kort
      card.classList.add('active');
    });
  });
});

/* ---------- careers: role select + apply form ---------- */
(function(){
  const roleCards = document.querySelectorAll('.role-card');
  const positionSelect = document.getElementById('applyPosition');

  roleCards.forEach(card => {
    card.addEventListener('click', (e) => {
      e.preventDefault();
      roleCards.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      if(positionSelect) positionSelect.value = card.dataset.role;
    });
  });

  const form = document.getElementById('applyForm');
  if(form){
    form.addEventListener('submit', (e) => {
      e.preventDefault();

      const name = document.getElementById('applyName').value.trim();
      const email = document.getElementById('applyEmail').value.trim();
      const position = document.getElementById('applyPosition').value;
      const message = document.getElementById('applyMessage').value.trim();

      const recipient = 'careers@tess-space.com'; // <-- ret til jeres rigtige ansøgnings-mail

      const subject = `Job Application — ${position}`;
      const body =
`Name: ${name}
Email: ${email}
Position: ${position}

Message:
${message || '(no message provided)'}`;

      const mailtoLink =
        `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

      window.location.href = mailtoLink;
    });
  }
})();

const messageField = document.getElementById('applyMessage');
if(messageField){
  const autoGrow = () => {
    messageField.style.height = 'auto';
    messageField.style.height = messageField.scrollHeight + 'px';
  };
  messageField.addEventListener('input', autoGrow);
  autoGrow(); // sæt korrekt højde fra start
}

/* ---------- send us a message: textarea auto-grow ---------- */
(function(){
  const msg = document.getElementById('smMessage');
  if(!msg) return;
  const grow = () => { msg.style.height='auto'; msg.style.height = msg.scrollHeight + 'px'; };
  msg.addEventListener('input', grow);
  grow();
})();

const burger = document.getElementById('burger');
  const siteHeader = document.getElementById('siteHeader');

  burger.addEventListener('click', () => {
    siteHeader.classList.toggle('nav-open');
  });

  /* ---------- send us a message: åbn mail med udfyldt indhold ---------- */
(function(){
  const form = document.getElementById('contactForm');
  if(!form) return;

  const TO = 'info@tessspace.com'; // <-- skift til jeres modtager-mail

  form.addEventListener('submit', (e) => {
    e.preventDefault(); // stopper normal submit; browserens validering kører stadig først

    const inquirySelect = form.elements['inquiry'];
    const inquiry = inquirySelect.value;
    const name    = form.elements['name'].value.trim();
    const org     = form.elements['organization'].value.trim();
    const email   = form.elements['email'].value.trim();
    const phone   = form.elements['phone'].value.trim();
    const message = form.elements['message'].value.trim();

    const subject = `${inquiry} – ${name}${org ? ' (' + org + ')' : ''}`;

    const body = [
      `Inquiry type: ${inquiry}`,
      `Name: ${name}`,
      `Organization: ${org || '-'}`,
      `Work email: ${email}`,
      `Phone: ${phone || '-'}`,
      '',
      'Message:',
      message
    ].join('\r\n');

    const href = 'mailto:' + TO +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);

    window.location.href = href;
  });
})();