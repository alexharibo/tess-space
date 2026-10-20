import { FALLBACK_UGV_STAT, DATA_ENDPOINT } from './ugv-data.js';
const count = document.getElementById('ugv-count');
const heading = document.getElementById('ugv-heading');
const source = document.getElementById('ugv-source');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function valid(data) {
  return data && data.metric === 'ukraine_ugv_logistics_casevac_missions_ytd' &&
    Number.isSafeInteger(data.value) && data.value >= 0 &&
    typeof data.through === 'string' && /^20\d\d-(0[1-9]|1[0-2])$/.test(data.through);
}
function display(data) {
  if (!valid(data)) return;
  const [year, month] = data.through.split('-').map(Number);
  count.textContent = new Intl.NumberFormat('da-DK').format(data.value);
  heading.textContent = `UGV missions recorded by Ukraine · Jan–${months[month-1]} ${year}`;
  const link = source.querySelector('a');
  source.textContent = 'Source: ';
  source.append(link);
  source.append(` · Ukraine MoD DELTA · figures through ${months[month-1]} ${year}. Logistics and casualty evacuation missions; excludes combat/fire-support missions.`);
}
display(FALLBACK_UGV_STAT);
if (DATA_ENDPOINT) {
  try {
    const response = await fetch(DATA_ENDPOINT, { cache: 'no-store', mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!valid(data)) throw new Error('Unexpected API response');
    display(data);
  } catch (error) {
    console.warn('UGV API unavailable; showing last reviewed snapshot.', error);
  }
}
