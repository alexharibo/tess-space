const count = document.getElementById('ugv-count');
const heading = document.getElementById('ugv-heading');
const source = document.getElementById('ugv-source');

try {
  const response = await fetch('./data/ugv-stat.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('No updated data');
  const data = await response.json();
  
  if (data.metric !== 'ukraine_ugv_logistics_casevac_missions_ytd' || !Number.isSafeInteger(data.value) || data.value < 0 || !/^2026-(0[1-9]|1[0-2])$/.test(data.through)) {
    throw new Error('Unexpected data format');
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month] = data.through.split('-').map(Number);
  
  count.textContent = new Intl.NumberFormat('da-DK').format(data.value);
  heading.textContent = `UGV missions recorded by Ukraine · Jan–${months[month - 1]} ${year}`;
  source.innerHTML = 'Source: <a href="https://unmannedsystemstracker.com/#ugv" target="_blank" rel="noopener noreferrer">Unmanned Systems Tracker</a> · Ukraine MoD DELTA · figures through ' + months[month - 1] + ' ' + year + '. Logistics and casualty evacuation missions; excludes combat/fire-support missions.';
} catch (error) {
  console.info('Using last verified UGV statistic:', error.message);
}