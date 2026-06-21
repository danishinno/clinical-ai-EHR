document.addEventListener('DOMContentLoaded', () => {
    const role = AppStorage.getItem('role');
    if (role !== 'admin') {
        window.location.href = 'login.html';
        return;
    }

    loadPendingDoctors();
    loadOverview();
    
    // Static Registration & Queuing Setup
    loadQueueDoctors();
    loadPatientsList();
    loadActiveQueue();

    // Guidelines and Monthly Reports Initializations
    loadGuidelines();
    
    const reportMonthSelect = document.getElementById('report-month-select');
    if (reportMonthSelect) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        reportMonthSelect.value = `${year}-${month}`;
    }
    loadMonthlyReport(false);

    const loadReportBtn = document.getElementById('load-report-btn');
    if (loadReportBtn) {
        loadReportBtn.addEventListener('click', () => loadMonthlyReport(true));
    }

    const newBtn = document.getElementById('mode-new-btn');
    const returningBtn = document.getElementById('mode-returning-btn');
    const newFields = document.getElementById('new-patient-fields');
    const returningFields = document.getElementById('returning-patient-fields');
    const form = document.getElementById('patient-registration-form');

    window.registrationMode = 'new'; // Global toggle state

    if (newBtn && returningBtn) {
        newBtn.addEventListener('click', () => {
            window.registrationMode = 'new';
            newBtn.className = 'toggle-btn active-toggle';
            returningBtn.className = 'toggle-btn';
            newBtn.style.background = '';
            newBtn.style.color = '';
            returningBtn.style.background = '';
            returningBtn.style.color = '';
            
            newFields.classList.remove('hidden');
            returningFields.classList.add('hidden');
            
            document.getElementById('reg-name').required = true;
            document.getElementById('reg-age').required = true;
            document.getElementById('reg-ic').required = true;
            document.getElementById('reg-patient-select').required = false;
        });

        returningBtn.addEventListener('click', () => {
            window.registrationMode = 'returning';
            returningBtn.className = 'toggle-btn active-toggle';
            newBtn.className = 'toggle-btn';
            newBtn.style.background = '';
            newBtn.style.color = '';
            returningBtn.style.background = '';
            returningBtn.style.color = '';
            
            newFields.classList.add('hidden');
            returningFields.classList.remove('hidden');
            
            document.getElementById('reg-name').required = false;
            document.getElementById('reg-age').required = false;
            document.getElementById('reg-ic').required = false;
            document.getElementById('reg-patient-select').required = true;
        });
    }

    if (form) {
        form.addEventListener('submit', handlePatientQueuing);
    }

    document.getElementById('logout-btn').addEventListener('click', () => {
        AppStorage.clear();
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

        const statCount = document.getElementById('approvals-stat-count');
        if (statCount) {
            statCount.innerText = data.doctors.length;
        }

        if (data.doctors.length === 0) {
            list.innerHTML = '<p class="placeholder-text" style="padding: 1rem; grid-column: span 3;">No pending approvals.</p>';
            return;
        }

        data.doctors.forEach(dr => {
            const card = document.createElement('div');
            card.className = 'item-card';
            const fullName = `${dr.first_name || ''} ${dr.last_name || ''}`.trim() || 'Unknown Name';
            const profId = dr.id_number || 'No ID';
            card.innerHTML = `
                <div class="card-id-row">
                    <span class="card-id">#${dr.id}</span>
                    <span class="badge badge-pending">Pending</span>
                </div>
                <div class="card-info-grid">
                    <div class="info-field">
                        <div class="info-label">Doctor Name</div>
                        <div class="info-value">Dr. ${fullName}</div>
                    </div>
                    <div class="info-field">
                        <div class="info-label">Professional ID</div>
                        <div class="info-value">${profId}</div>
                    </div>
                    <div class="info-field" style="grid-column: span 2;">
                        <div class="info-label">Username / Email</div>
                        <div class="info-value">${dr.username || 'N/A'}</div>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn-approve" style="width: 100%;" onclick="approveDoctor(${dr.id})">Approve Doctor</button>
                </div>
            `;
            list.appendChild(card);
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
            drDiv.className = 'white-panel';

            let patientsHtml = dr.patients.length > 0
                ? dr.patients.map(p => `
                    <div style="margin-top:0.5rem; border-bottom: 1px dashed var(--border-color); padding-bottom: 0.5rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <button class="history-btn" onclick="toggleNotes('admin-notes-${p.encounter_id}')" style="background:none; border:none; color:var(--primary-color); font-weight:600; cursor:pointer;">
                                ▶ ${p.patient_name} (${new Date(p.created_at).toLocaleString()})
                            </button>
                            <button class="btn btn-secondary" style="background: var(--danger-color, #ff3b30); color: white; border: none; padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; cursor: pointer;" onclick="deleteEncounter(${p.encounter_id})">
                                Delete Visit
                            </button>
                        </div>
                        <div id="admin-notes-${p.encounter_id}" class="notes-content" style="display:none; margin-top:0.5rem; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); padding: 0.8rem; border-radius: var(--radius-sm);">
                            ${formatJsonStr(p.structured_notes_json)}
                        </div>
                    </div>
                  `).join('')
                : '<p class="placeholder-text" style="margin-top:0.5rem; color:var(--text-muted);">No patients yet.</p>';

            const displayName = dr.first_name ? `${dr.first_name} ${dr.last_name || ''}`.trim() : dr.username;
            drDiv.innerHTML = `
                <h3 style="border-bottom:1px solid var(--border-color); padding-bottom:0.5rem; margin-top:0.5rem; color:var(--primary-color);">Dr. ${displayName}</h3>
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
        let tableHtml = '<table style="width: 100%; border-collapse: collapse; margin-top: 0.5rem; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden;">';
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
                <tr style="border-bottom: 1px solid var(--border-color);">
                    <th style="padding: 0.6rem 0.8rem; text-align: left; width: 30%; color: var(--primary-color); font-weight: 600; background: rgba(0, 122, 255, 0.05); font-size:0.9rem;">${formattedKey}</th>
                    <td style="padding: 0.6rem 0.8rem; color: var(--text-main); font-size:0.9rem;">${formattedValue}</td>
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
            loadGuidelines();
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

// STATIC REGISTRATION AND QUEUING MODULES
async function loadQueueDoctors() {
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/doctors');
        const data = await response.json();
        
        const select = document.getElementById('reg-doctor-select');
        select.innerHTML = '<option value="">-- Choose a Doctor --</option>';
        
        data.doctors.forEach(dr => {
            const name = `Dr. ${dr.first_name || ''} ${dr.last_name || ''}`.trim() || dr.username;
            select.innerHTML += `<option value="${dr.id}">${name} (${dr.specialty || 'General Practitioner'})</option>`;
        });
        
        window.doctorsList = data.doctors;
    } catch (err) {
        console.error('Error loading queue doctors:', err);
    }
}

async function loadPatientsList() {
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/patients-list');
        const data = await response.json();
        
        const select = document.getElementById('reg-patient-select');
        select.innerHTML = '<option value="">-- Choose a patient --</option>';
        
        data.patients.forEach(p => {
            select.innerHTML += `<option value="${p.id}" data-name="${p.patient_name}" data-age="${p.age}" data-gender="${p.gender}" data-ic="${p.ic_number}">${p.patient_name} (${p.age} y/o, ${p.gender}) - IC: ${p.ic_number}</option>`;
        });
    } catch (err) {
        console.error('Error loading patients list:', err);
    }
}

async function loadActiveQueue() {
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/active-queue');
        const data = await response.json();
        
        const container = document.getElementById('live-queue-container');
        container.innerHTML = '';
        
        if (data.queue.length === 0) {
            container.innerHTML = '<p class="placeholder-text" style="padding: 1rem;">No patients currently in queue.</p>';
            return;
        }
        
        data.queue.forEach(p => {
            const div = document.createElement('div');
            div.style.display = 'flex';
            div.style.justify = 'space-between';
            div.style.alignItems = 'center';
            div.style.padding = '1rem';
            div.style.background = 'rgba(255, 255, 255, 0.03)';
            div.style.borderRadius = '8px';
            div.style.border = '1px solid var(--border-color)';
            
            let doctorOptions = '';
            if (window.doctorsList) {
                window.doctorsList.forEach(dr => {
                    const name = `Dr. ${dr.first_name || ''} ${dr.last_name || ''}`.trim() || dr.username;
                    const selected = dr.id === p.doctor_id ? 'selected' : '';
                    doctorOptions += `<option value="${dr.id}" ${selected}>${name}</option>`;
                });
            }
            
            div.innerHTML = `
                <div>
                    <strong style="font-size: 1rem; color: var(--text-main);">${p.patient_name}</strong>
                    <span style="font-size: 0.8rem; color: var(--text-muted); margin-left: 0.5rem;">(${p.age} y/o, ${p.gender}) | ID: ${p.ic_number}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 0.8rem;">
                    <label style="font-size: 0.85rem; font-weight: 600; color: var(--text-muted);">Re-assign Dr:</label>
                    <select onchange="reassignPatient(${p.patient_id}, this.value)" style="padding: 0.4rem 0.6rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.05); color: var(--text-main);">
                        ${doctorOptions}
                    </select>
                </div>
            `;
            container.appendChild(div);
        });
    } catch (err) {
        console.error('Error loading active queue:', err);
    }
}

window.reassignPatient = async function(patientId, doctorId) {
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/reassign-patient', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patient_id: patientId, doctor_id: parseInt(doctorId) })
        });
        const data = await response.json();
        if (data.success) {
            loadActiveQueue();
            loadOverview();
        } else {
            alert('Reassignment failed.');
        }
    } catch (err) {
        alert('Network error during reassignment.');
    }
}

async function handlePatientQueuing(e) {
    e.preventDefault();
    
    const statusDiv = document.getElementById('registration-status');
    const submitBtn = document.getElementById('register-submit-btn');
    
    let payload = {};
    const doctorId = parseInt(document.getElementById('reg-doctor-select').value);
    
    if (window.registrationMode === 'new') {
        const name = document.getElementById('reg-name').value.trim();
        const age = parseInt(document.getElementById('reg-age').value);
        const gender = document.getElementById('reg-gender').value;
        const ic = document.getElementById('reg-ic').value.trim();
        
        // Strict Alphanumeric check in frontend to reject special characters
        const alphanumeric = /^[a-zA-Z0-9]+$/;
        if (!alphanumeric.test(ic)) {
            statusDiv.textContent = 'Access Denied: Patient ID / IC Number cannot contain special characters or spaces.';
            statusDiv.style.color = 'red';
            return;
        }
        
        payload = {
            patient_name: name,
            age: age,
            gender: gender,
            ic_number: ic,
            doctor_id: doctorId
        };
    } else {
        const select = document.getElementById('reg-patient-select');
        const selectedOpt = select.options[select.selectedIndex];
        
        if (!selectedOpt.value) {
            alert('Please select a returning patient.');
            return;
        }
        
        payload = {
            patient_name: selectedOpt.getAttribute('data-name'),
            age: parseInt(selectedOpt.getAttribute('data-age')),
            gender: selectedOpt.getAttribute('data-gender'),
            ic_number: selectedOpt.getAttribute('data-ic'),
            doctor_id: doctorId
        };
    }
    
    try {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Queuing Patient...';
        statusDiv.textContent = '';
        
        const response = await fetch('http://127.0.0.1:8000/admin/register-patient', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusDiv.textContent = data.message;
            statusDiv.style.color = 'green';
            
            // Clear inputs
            document.getElementById('reg-name').value = '';
            document.getElementById('reg-age').value = '';
            document.getElementById('reg-ic').value = '';
            document.getElementById('reg-patient-select').value = '';
            document.getElementById('reg-doctor-select').value = '';
            
            // Refresh lists
            loadPatientsList();
            loadActiveQueue();
            loadOverview();
        } else {
            statusDiv.textContent = data.message;
            statusDiv.style.color = 'red';
        }
    } catch (err) {
        statusDiv.textContent = 'Network error or server unreachable.';
        statusDiv.style.color = 'red';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Queue Patient for Consultation';
    }
}

async function loadGuidelines() {
    const listContainer = document.getElementById('guidelines-list-container');
    if (!listContainer) return;
    
    try {
        const response = await fetch('http://127.0.0.1:8000/admin/guidelines');
        const data = await response.json();
        
        if (data.success && data.guidelines) {
            if (data.guidelines.length === 0) {
                listContainer.innerHTML = '<p class="placeholder-text" style="padding: 0.5rem 0;">No guidelines uploaded yet.</p>';
                return;
            }
            
            let html = `
                <table style="width: 100%; border-collapse: collapse; margin-top: 0.5rem; text-align: left;">
                    <thead>
                        <tr style="border-bottom: 2px solid var(--border-color); font-size: 0.85rem; font-weight: 700; color: var(--text-muted);">
                            <th style="padding: 0.5rem 1rem 0.5rem 0;">Filename</th>
                            <th style="padding: 0.5rem 1rem;">Upload Date</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            
            data.guidelines.forEach(g => {
                const dateStr = new Date(g.uploaded_at).toLocaleString();
                html += `
                    <tr style="border-bottom: 1px solid var(--border-color); font-size: 0.95rem;">
                        <td style="padding: 0.8rem 1rem 0.8rem 0; font-weight: 600; color: var(--text-main);">📄 ${g.filename}</td>
                        <td style="padding: 0.8rem 1rem; color: var(--text-muted);">${dateStr}</td>
                    </tr>
                `;
            });
            
            html += `
                    </tbody>
                </table>
            `;
            listContainer.innerHTML = html;
        } else {
            listContainer.innerHTML = '<p class="placeholder-text" style="padding: 0.5rem 0; color: red;">Failed to load guidelines.</p>';
        }
    } catch (e) {
        console.error('Error fetching guidelines:', e);
        listContainer.innerHTML = '<p class="placeholder-text" style="padding: 0.5rem 0; color: red;">Network error loading guidelines.</p>';
    }
}

async function loadMonthlyReport(shouldDownload = false) {
    const reportMonthSelect = document.getElementById('report-month-select');
    const selectedMonth = reportMonthSelect ? reportMonthSelect.value : '';
    const url = `http://127.0.0.1:8000/report/monthly` + (selectedMonth ? `?month=${selectedMonth}` : '');
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('report-total-visits').innerText = data.summary.total_visits;
            const upEl = document.getElementById('report-unique-patients');
            if (upEl) upEl.innerText = data.summary.unique_patients ?? 0;
            const nrEl = document.getElementById('report-new-registrations');
            if (nrEl) nrEl.innerText = data.summary.new_registrations ?? 0;
            
            // Render Doctor Summary
            const docList = document.getElementById('report-doctor-summary-list');
            if (docList) {
                docList.innerHTML = '';
                if (data.summary.doctor_summary && data.summary.doctor_summary.length > 0) {
                    data.summary.doctor_summary.forEach(d => {
                        const row = document.createElement('div');
                        row.style.display = 'flex';
                        row.style.justifyContent = 'space-between';
                        row.style.padding = '0.5rem 0';
                        row.style.borderBottom = '1px solid var(--border-color)';
                        row.innerHTML = `
                            <span style="font-weight:600; color:var(--text-main);">${d.doctor_name}</span>
                            <span style="color:var(--primary-color); font-weight:700;">${d.visit_count} consults</span>
                        `;
                        docList.appendChild(row);
                    });
                } else {
                    docList.innerHTML = '<p class="placeholder-text" style="padding:0.5rem 0;">No consultation records for this month.</p>';
                }
            }
            
            // Top Prescribed Drugs panel removed from admin view (clinical metric, not admin metric)
            
            // Render Daily Breakdown (with horizontal bar visual trends)
            const dailyList = document.getElementById('report-daily-breakdown-list');
            if (dailyList) {
                dailyList.innerHTML = '';
                if (data.summary.date_summary && data.summary.date_summary.length > 0) {
                    const maxVisits = Math.max(...data.summary.date_summary.map(d => d.visit_count), 0);
                    data.summary.date_summary.forEach(day => {
                        const percentage = maxVisits > 0 ? (day.visit_count / maxVisits) * 100 : 0;
                        const row = document.createElement('div');
                        row.style.display = 'flex';
                        row.style.alignItems = 'center';
                        row.style.justifyContent = 'space-between';
                        row.style.padding = '0.4rem 0';
                        row.style.borderBottom = '1px solid var(--border-color)';
                        row.innerHTML = `
                            <span style="color:var(--text-muted); width: 90px; flex-shrink: 0; font-size: 0.85rem;">${day.date}</span>
                            <div style="flex-grow: 1; margin: 0 1rem; height: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 4px; overflow: hidden; position: relative;">
                                <div style="width: ${percentage}%; height: 100%; background: var(--primary-color); border-radius: 4px;"></div>
                            </div>
                            <span style="color:var(--text-main); font-weight:600; width: 60px; text-align: right; font-size: 0.85rem;">${day.visit_count} visits</span>
                        `;
                        dailyList.appendChild(row);
                    });
                } else {
                    dailyList.innerHTML = '<p class="placeholder-text" style="padding:0.5rem 0;">No data.</p>';
                }
            }

            // Auto-download PDF if requested
            if (shouldDownload) {
                let targetMonth = selectedMonth;
                if (!targetMonth) {
                    const now = new Date();
                    targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                }
                await downloadReportPDF(data, targetMonth);
            }
        } else {
            alert('Failed to load report: ' + data.message);
        }
    } catch (e) {
        console.error('Error fetching report:', e);
        alert('Network error loading report data.');
    }
}

async function downloadReportPDF(data, monthStr) {
    let formattedMonth = monthStr;
    try {
        const parts = monthStr.split('-');
        const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1);
        formattedMonth = dateObj.toLocaleString('default', { month: 'long', year: 'numeric' });
    } catch (e) {}

    const docRows = (data.summary.doctor_summary && data.summary.doctor_summary.length > 0)
        ? data.summary.doctor_summary.map(d => `
            <div class="row-item">
                <span class="row-label">${d.doctor_name}</span>
                <span class="row-value blue">${d.visit_count} consultations</span>
            </div>`).join('')
        : '<p class="empty-note">No consultations recorded.</p>';

    const newRegCount = data.summary.new_registrations ?? 0;
    const uniquePatCount = data.summary.unique_patients ?? 0;

    const maxVisits = data.summary.date_summary ? Math.max(...data.summary.date_summary.map(d => d.visit_count), 0) : 0;
    const dailyRows = (data.summary.date_summary && data.summary.date_summary.length > 0)
        ? data.summary.date_summary.map(day => {
            const pct = maxVisits > 0 ? (day.visit_count / maxVisits) * 100 : 0;
            return `<div class="daily-row">
                <span class="daily-date">${day.date}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                <span class="daily-count">${day.visit_count} visits</span>
            </div>`;
        }).join('')
        : '<p class="empty-note">No daily data available.</p>';

    const logoHtml = window.SYSTEM_LOGO_BASE64
        ? `<img src="${window.SYSTEM_LOGO_BASE64}" style="width:50px;height:50px;border-radius:50%;object-fit:contain;">`
        : `<div style="width:50px;height:50px;border-radius:50%;background:#0284c7;display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:12px;">HS</div>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>HealthSync Report - ${formattedMonth}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;background:#fff;color:#1e293b;padding:28px 34px;font-size:13px}
  .header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #e2e8f0;padding-bottom:14px;margin-bottom:20px}
  .header-left{display:flex;align-items:center;gap:12px}
  .clinic-name{font-family:'DM Serif Display',serif;font-size:21px;color:#0f172a;font-weight:700}
  .clinic-sub{font-size:11px;color:#64748b;margin-top:2px}
  .month-badge{background:#e0f2fe;color:#0369a1;font-weight:700;font-size:11px;padding:4px 12px;border-radius:9999px;text-transform:uppercase;display:inline-block}
  .generated{font-size:10px;color:#94a3b8;margin-top:4px;text-align:right}
  .cards{display:flex;gap:16px;margin-bottom:20px}
  .card{flex:1;border:1px solid #e2e8f0;background:#fafafa;padding:13px;border-radius:10px;text-align:center}
  .card-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
  .card-value{font-family:'DM Serif Display',serif;font-size:32px;font-weight:700;margin-top:5px}
  .card-value.blue{color:#0284c7}.card-value.red{color:#ef4444}
  .split{display:flex;gap:16px;margin-bottom:20px}
  .box{border:1px solid #e2e8f0;padding:13px;border-radius:10px;background:#fff}
  .box.wide{flex:1.2}.box.narrow{flex:1}
  .box-title{font-size:10px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin-bottom:8px}
  .row-item{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f1f5f9}
  .row-label{font-weight:600;color:#334155}.row-value{font-weight:700}
  .row-value.blue{color:#0284c7}.row-value.red{color:#ef4444}
  .daily-row{display:flex;align-items:center;padding:4px 0;border-bottom:1px dashed #e2e8f0}
  .daily-date{width:86px;flex-shrink:0;color:#475569;font-size:12px}
  .bar-track{flex-grow:1;margin:0 12px;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden}
  .bar-fill{height:100%;background:#0284c7;border-radius:3px}
  .daily-count{width:64px;text-align:right;font-weight:600;color:#0f172a;font-size:12px}
  .empty-note{font-style:italic;color:#94a3b8;font-size:12px;padding:4px 0}
  .full-box{border:1px solid #e2e8f0;padding:13px;border-radius:10px;background:#fff}
  .footer{text-align:center;margin-top:28px;border-top:1px solid #e2e8f0;padding-top:11px;font-size:10px;color:#94a3b8;line-height:1.5}
  @media print{@page{margin:10mm;size:A4 portrait}body{padding:0}}
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${logoHtml}
      <div>
        <div class="clinic-name">Health Sync EHR</div>
        <div class="clinic-sub">Clinic Management System &bull; Performance Audit</div>
      </div>
    </div>
    <div style="text-align:right">
      <div class="month-badge">${formattedMonth}</div>
      <div class="generated">Report Generated: ${new Date().toLocaleString()}</div>
    </div>
  </div>
  <div class="cards">
    <div class="card">
      <div class="card-label">Total Patient Visits</div>
      <div class="card-value blue">${data.summary.total_visits}</div>
    </div>
    <div class="card">
      <div class="card-label">Unique Patients Seen</div>
      <div class="card-value" style="color:#34c759">${uniquePatCount}</div>
    </div>
  </div>
  <div class="split">
    <div class="box wide">
      <div class="box-title">Consultations by Medical Officer</div>
      ${docRows}
    </div>
    <div class="box narrow" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
      <div class="box-title" style="width:100%">New Patient Registrations</div>
      <div style="font-family:'DM Serif Display',serif;font-size:3.5rem;font-weight:700;color:#5856d6;margin:0.5rem 0">${newRegCount}</div>
      <div style="font-size:11px;color:#8e8e93;text-transform:uppercase;letter-spacing:0.05em">New Patients This Month</div>
    </div>
  </div>
  <div class="full-box">
    <div class="box-title">Daily Consultation Trends</div>
    ${dailyRows}
  </div>
  <div class="footer">
    This clinic report is generated automatically by Health Sync EHR.<br>
    For official record queries, contact administration at contact@healthsync.my
  </div>
  <script>window.onload=function(){window.print()};<\/script>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=860,height=1100,scrollbars=yes');
    if (!win) {
        alert('Popup blocked! Please allow popups for localhost:8080 in your browser settings and try again.');
        return;
    }
    win.document.write(html);
    win.document.close();
}
