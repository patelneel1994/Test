// ===== LOCATIONS =====
async function loadLocations() {
  try {
    const res = await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/${CONFIG.locationsTable}?select=id,name&order=name.asc`);
    locations = await res.json();
    renderLocations();
  } catch (e) {
    showError('Failed to load locations', e.message);
  }
}

function renderLocations() {
  const select = document.getElementById('loc-select');
  const saved  = localStorage.getItem('inv_location') || '';
  select.innerHTML = '<option value="">— select location —</option>';
  locations.forEach(loc => {
    const o = document.createElement('option');
    o.value = loc.name; o.textContent = loc.name;
    if (loc.name === saved) o.selected = true;
    select.appendChild(o);
  });
  document.getElementById('location-list').innerHTML = locations.map(loc => `
    <div class="location-item">
      <span class="location-name">${loc.name}</span>
      <button class="loc-del-btn" onclick="deleteLocation(${loc.id})">×</button>
    </div>`).join('');
}

async function addLocation() {
  const input = document.getElementById('new-loc-input');
  const val = input.value.trim();
  if (!val) return;
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/${CONFIG.locationsTable}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name: val })
    });
    input.value = '';
    await loadLocations();
  } catch (e) {
    showError('Failed to add location', e.message);
  }
}

async function deleteLocation(id) {
  try {
    await sbFetch(`${CONFIG.supabaseUrl}/rest/v1/${CONFIG.locationsTable}?id=eq.${id}`, {
      method: 'DELETE',
      headers: { 'Prefer': 'return=minimal' }
    });
    await loadLocations();
  } catch (e) {
    showError('Failed to delete location', e.message);
  }
}

function openLocationModal()  { document.getElementById('loc-modal').classList.add('open'); }
function closeLocationModal() { document.getElementById('loc-modal').classList.remove('open'); refocusBarcode(); }
