document.addEventListener('DOMContentLoaded', () => {
    const role = localStorage.getItem('role');
    if (role !== 'admin') {
        window.location.href = 'login.html';
        return;
    }

    loadPendingDoctors();
    loadOverview();

    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.clear();
        window.location.href = 'login.html';
    });

    document.getElementById('upload-guideline-form').addEventListener('submit', handleGuidelineUpload);
});

async function loadPendingDoctors() {
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/pending');
        const data = await response.json();

        const list = document.getElementById('pending-list');
        list.innerHTML = '';

        if (data.doctors.length === 0) {
            list.innerHTML = '<p class="placeholder-text" style="padding: 1rem;">No pending approvals.</p>';
            return;
        }

        data.doctors.forEach(dr => {
            const li = document.createElement('li');
            li.className = 'doctor-item';
            const fullName = `${dr.first_name || ''} ${dr.last_name || ''}`.trim() || 'Unknown Name';
            const profId = dr.id_number || 'No ID';
            li.innerHTML = `
                <span><strong>Dr. ${fullName}</strong> (ID: ${profId})</span>
                <button class="btn btn-primary" onclick="approveDoctor(${dr.id})">Approve</button>
            `;
            list.appendChild(li);
        });
    } catch (err) {
        console.error('Error fetching pending doctors', err);
    }
}

async function approveDoctor(id) {
    try {
        await fetch('http://127.0.0.1:8000/admin/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doctor_id: id })
        });
        loadPendingDoctors();
        loadOverview();
    } catch (err) {
        alert('Error approving doctor');
    }
}

async function loadOverview() {
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/overview');
        const data = await response.json();

        const container = document.getElementById('overview-list');
        container.innerHTML = '';

        data.overview.forEach(dr => {
            const drDiv = document.createElement('div');
            drDiv.className = 'patient-card';

            let patientsHtml = dr.patients.length > 0
                ? dr.patients.map(p => `
                    <div style="margin-top:0.5rem; border-bottom: 1px dashed rgba(0,0,0,0.1); padding-bottom: 0.5rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <button class="history-btn" onclick="toggleNotes('admin-notes-${p.encounter_id}')" style="background:none; border:none; color:#0071e3; font-weight:600; cursor:pointer;">
                                ▶ ${p.patient_name} (${new Date(p.created_at).toLocaleString()})
                            </button>
                            <button class="btn btn-secondary" style="background: var(--danger-color, #ff3b30); color: white; border: none; padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; cursor: pointer;" onclick="deleteEncounter(${p.encounter_id})">
                                🗑️ Delete Visit
                            </button>
                        </div>
                        <div id="admin-notes-${p.encounter_id}" class="notes-content" style="display:none; margin-top:0.5rem; background: rgba(255,255,255,0.9); padding: 0.5rem; border-radius: 6px;">
                            ${formatJsonStr(p.structured_notes_json)}
                        </div>
                    </div>
                  `).join('')
                : '<p class="placeholder-text" style="margin-top:0.5rem; color:#666;">No patients yet.</p>';

            const displayName = dr.first_name ? `${dr.first_name} ${dr.last_name || ''}`.trim() : dr.username;
            drDiv.innerHTML = `
                <h3 style="border-bottom:1px solid #ccc; padding-bottom:0.5rem; margin-top:0.5rem; color:var(--primary-color);">Dr. ${displayName}</h3>
                ${patientsHtml}
            `;
            container.appendChild(drDiv);
        });
    } catch (err) {
        console.error('Error fetching overview', err);
    }
}

async function deleteEncounter(encounterId) {
    if (!confirm('Are you sure you want to permanently delete this patient record? This action cannot be undone.')) return;

    try {
        const response = await fetch(`http://127.0.0.1:8000/admin/patient/${encounterId}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (data.success) {
            alert('Patient visit encounter log deleted successfully.');
            loadOverview();
        } else {
            alert('Error deleting encounter record: ' + data.message);
        }
    } catch (err) {
        alert('Network error while deleting encounter log entry.');
    }
}

function toggleNotes(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = el.style.display === 'block' ? 'none' : 'block';
    }
}

function formatJsonStr(jsonStr) {
    try {
        const obj = JSON.parse(jsonStr);
        let tableHtml = '<table style="width: 100%; border-collapse: collapse; margin-top: 0.5rem; background: white; border-radius: var(--radius-sm); overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">';
        tableHtml += '<tbody>';
        for (const [key, value] of Object.entries(obj)) {
            // FIX: Changed from key.startswith to proper native camelCase key.startsWith
            if (key.startsWith('_')) continue;
            const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            let formattedValue = '';
            if (Array.isArray(value)) {
                formattedValue = value.join(', ');
            } else if (typeof value === 'object' && value !== null) {
                formattedValue = JSON.stringify(value);
            } else {
                formattedValue = value !== null && value !== undefined ? value : '<span style="color:var(--text-muted)">N/A</span>';
            }

            tableHtml += `
                <tr style="border-bottom: 1px solid #e5e5e5;">
                    <th style="padding: 0.6rem 0.8rem; text-align: left; width: 30%; color: #00a896; font-weight: 600; background: rgba(0, 168, 150, 0.05); font-size:0.9rem;">${formattedKey}</th>
                    <td style="padding: 0.6rem 0.8rem; color: #1d1d1f; font-size:0.9rem;">${formattedValue}</td>
                </tr>
            `;
        }
        tableHtml += '</tbody></table>';
        return tableHtml;
    } catch {
        return jsonStr;
    }
}

async function handleGuidelineUpload(e) {
    e.preventDefault();
    const fileInput = document.getElementById('guideline-file');
    const statusDiv = document.getElementById('upload-status');
    const uploadBtn = document.getElementById('upload-btn');

    if (!fileInput.files.length) return;

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading & Parsing...';
        statusDiv.textContent = '';

        const response = await fetch('http://127.0.0.1:8000/admin/upload-guideline', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.success) {
            statusDiv.textContent = data.message;
            statusDiv.style.color = 'green';
            fileInput.value = '';
        } else {
            statusDiv.textContent = data.message;
            statusDiv.style.color = 'red';
        }
    } catch (err) {
        statusDiv.textContent = 'Network error or server failed.';
        statusDiv.style.color = 'red';
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload Guideline';
    }
}