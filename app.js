const userId = localStorage.getItem('user_id');
if (!userId) {
    window.location.href = 'login.html';
}

document.getElementById('dr-name-display').textContent = localStorage.getItem('first_name') || localStorage.getItem('username') || '';

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.clear();
    window.location.href = 'login.html';
});

const menuDotsBtn = document.getElementById('menu-dots-btn');
const headerDropdown = document.getElementById('header-dropdown');

menuDotsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    headerDropdown.classList.toggle('show');
    headerDropdown.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
    if (!headerDropdown.contains(e.target) && !menuDotsBtn.contains(e.target)) {
        headerDropdown.classList.remove('show');
        headerDropdown.classList.add('hidden');
    }
});

const startBtn = document.getElementById('start-btn');
const finishBtn = document.getElementById('finish-btn');
const transcriptPlaceholder = document.getElementById('transcript-placeholder');
const transcriptContent = document.getElementById('transcript-content');
const loadingState = document.getElementById('loading-state');
const dataGrid = document.getElementById('extracted-data');

const valName = document.getElementById('val-name');
const valAge = document.getElementById('val-age');
const valGender = document.getElementById('val-gender');
const valSubjective = document.getElementById('val-subjective');
const valObjective = document.getElementById('val-objective');
const valAssessment = document.getElementById('val-assessment');
const valPlan = document.getElementById('val-plan');

const queueRedDot = document.getElementById('queue-red-dot');
const queueSection = document.getElementById('queue-section');
const queueList = document.getElementById('queue-list');

let socket;
let isRecording = false;
let currentEncounterId = null;
let currentDocId = null;
let globalStream = null;
let cdsHistory = [];
let loadedEncounters = [];
let currentPatientId = null;

async function getGlobalStream() {
    if (!globalStream) {
        globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return globalStream;
}

startBtn.addEventListener('click', async () => {
    if (isRecording) return;

    try {
        const stream = await getGlobalStream();
        socket = new WebSocket('ws://127.0.0.1:8000/live-transcribe');

        socket.onopen = () => {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            const source = audioContext.createMediaStreamSource(stream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);

            source.connect(processor);
            processor.connect(audioContext.destination);

            processor.onaudioprocess = (e) => {
                if (socket.readyState === WebSocket.OPEN) {
                    const float32Array = e.inputBuffer.getChannelData(0);
                    socket.send(float32Array.buffer);
                }
            };

            window.localProcessor = processor;
            window.localAudioContext = audioContext;

            isRecording = true;
            startBtn.classList.add('recording');
            startBtn.innerHTML = '<span class="icon"></span> Recording...';
            finishBtn.disabled = false;
            transcriptPlaceholder.classList.add('hidden');
        };

        socket.onmessage = (event) => {
            const text = event.data;
            if (text) {
                const currentText = transcriptContent.innerText;
                const needsSpace = currentText.length > 0 && !currentText.endsWith(' ');
                const span = document.createElement('span');
                span.textContent = (needsSpace ? ' ' : '') + text;
                transcriptContent.appendChild(span);
                transcriptContent.parentElement.scrollTop = transcriptContent.parentElement.scrollHeight;
            }
        };

        socket.onerror = () => { stopRecordingUI(); };
    } catch (err) {
        alert('Microphone access hardware capture fault.');
    }
});

finishBtn.addEventListener('click', async () => {
    if (!isRecording) return;

    if (window.localProcessor) window.localProcessor.disconnect();
    if (window.localAudioContext) window.localAudioContext.close();
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();

    stopRecordingUI();
    const fullTranscript = transcriptContent.innerText.trim();
    if (!fullTranscript) return;

    dataGrid.classList.add('hidden');
    loadingState.classList.remove('hidden');

    try {
        const response = await fetch('http://127.0.0.1:8000/process-dictation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ doctor_id: userId, transcript: fullTranscript, patient_id: currentPatientId })
        });

        const data = await response.json();
        currentEncounterId = data._encounter_id;
        currentDocId = data._doc_id;
        if (data._patient_id) {
            currentPatientId = data._patient_id;
        }

        valName.textContent = window.formatData(data.name);
        valAge.textContent = window.formatData(data.age);
        valGender.textContent = window.formatData(data.gender || (active_patient_details ? active_patient_details.gender : valGender.textContent));
        valSubjective.textContent = window.formatData(data.subjective);
        valObjective.textContent = window.formatData(data.objective);
        valAssessment.textContent = window.formatData(data.assessment);
        valPlan.textContent = window.formatData(data.plan);

        // Immediately poll queue to reflect completion
        if (typeof pollQueue === 'function') pollQueue();

    } catch (error) {
        alert('Failed to extract unstructured stream patterns.');
    } finally {
        loadingState.classList.add('hidden');
        dataGrid.classList.remove('hidden');
        if (currentEncounterId) {
            document.getElementById('save-notes-btn').classList.remove('hidden');
        }
    }
});

function stopRecordingUI() {
    isRecording = false;
    startBtn.classList.remove('recording');
    startBtn.innerHTML = '<span class="icon"></span> Start Live Dictation';
    finishBtn.disabled = true;
}

const saveNotesBtn = document.getElementById('save-notes-btn');
if (saveNotesBtn) {
    saveNotesBtn.addEventListener('click', async () => {
        if (!currentEncounterId && !currentPatientId) {
            alert('Please select a patient from the queue or start live dictation first.');
            return;
        }

        const prescriptions = [];
        document.querySelectorAll('.prescription-row').forEach(row => {
            const drug = row.querySelector('.presc-drug').value.trim();
            const dosage = row.querySelector('.presc-dosage').value.trim();
            const freq = row.querySelector('.presc-freq').value.trim();
            const dur = row.querySelector('.presc-duration').value.trim();
            if (drug) {
                prescriptions.push({ drug, dosage, frequency: freq, duration: dur });
            }
        });

        const updatedNotes = {
            name: valName.textContent,
            age: valAge.textContent,
            subjective: valSubjective.textContent,
            objective: valObjective.textContent,
            assessment: valAssessment.textContent,
            plan: valPlan.textContent,
            prescriptions: prescriptions
        };

        if (currentEncounterId) {
            try {
                saveNotesBtn.disabled = true;
                saveNotesBtn.innerHTML = 'Saving...';
                const response = await fetch(`http://127.0.0.1:8000/encounter/${currentEncounterId}/notes`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        encounter_id: currentEncounterId,
                        doc_id: currentDocId,
                        updated_notes: updatedNotes,
                        patient_name: updatedNotes.name
                    })
                });

                const result = await response.json();
                if (result.success) {
                    saveNotesBtn.innerHTML = '<span class="icon"></span> Saved';
                    cdsHistory = [];
                    window.triggerDigitallySignedState();
                    setTimeout(() => {
                        saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                    }, 2000);
                } else {
                    alert('Error updating consultation: ' + result.message);
                    saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                }
            } catch (err) {
                alert('Failed to execute update sequence pipeline.');
                saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
            } finally {
                saveNotesBtn.disabled = false;
            }
        } else if (currentPatientId) {
            try {
                saveNotesBtn.disabled = true;
                saveNotesBtn.innerHTML = 'Saving...';

                const response = await fetch(`http://127.0.0.1:8000/encounter/save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        doctor_id: parseInt(userId),
                        patient_id: currentPatientId,
                        transcript: "Manually entered clinical note.",
                        structured_notes: updatedNotes
                    })
                });

                const result = await response.json();
                if (result.success) {
                    currentEncounterId = result.encounter_id;
                    currentDocId = result.doc_id;

                    saveNotesBtn.innerHTML = '<span class="icon">✅</span> Saved';
                    cdsHistory = [];
                    window.triggerDigitallySignedState();

                    if (typeof pollQueue === 'function') pollQueue();

                    setTimeout(() => {
                        saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                    }, 2000);
                } else {
                    alert('Error creating consultation: ' + result.message);
                    saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                }
            } catch (err) {
                alert('Failed to create new manual consultation.');
                saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
            } finally {
                saveNotesBtn.disabled = false;
            }
        }
    });
}

const chatArea = document.getElementById('chat-area');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const cdsLoading = document.getElementById('cds-loading');
const cdsFab = document.getElementById('cds-fab');
const cdsPanel = document.getElementById('cds-panel');
const closeCdsBtn = document.getElementById('close-cds-btn');

cdsFab.addEventListener('click', () => { cdsPanel.classList.toggle('hidden'); });
closeCdsBtn.addEventListener('click', () => { cdsHistory = []; cdsPanel.classList.add('hidden'); });

async function askClinicalBrain(question) {
    if (!question.trim()) return;

    addChatBubble(question, true);
    chatInput.value = '';
    cdsLoading.classList.remove('hidden');

    try {
        const response = await fetch('http://127.0.0.1:8000/ask-guidelines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_question: question,
                transcript: transcriptContent.innerText.trim(),
                doctor_id: parseInt(userId),
                patient_id: currentPatientId ? parseInt(currentPatientId) : null,
                history: cdsHistory
            })
        });

        const data = await response.json();
        let aiMarkdown = data.answer || 'No response.';

        cdsHistory.push({ role: 'user', content: question });
        cdsHistory.push({ role: 'assistant', content: aiMarkdown });

        if (typeof marked !== 'undefined') aiMarkdown = marked.parse(aiMarkdown);
        addChatBubble(aiMarkdown, false, true);

    } catch (err) {
        addChatBubble(' CDS server pipeline fallback connection error.', false);
    } finally {
        cdsLoading.classList.add('hidden');
    }
}

chatSendBtn.addEventListener('click', () => askClinicalBrain(chatInput.value));
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') askClinicalBrain(chatInput.value); });

// Smart Suggestion Buttons Event Listeners
document.querySelectorAll('.smart-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const query = btn.getAttribute('data-query');
        if (query) {
            askClinicalBrain(query);
        }
    });
});

function addChatBubble(text, isUser = false, isHtml = false) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isUser ? 'user-bubble' : 'ai-bubble'}`;
    if (isHtml) {
        bubble.innerHTML = text;
        if (!isUser) {
            const btn = document.createElement('button');
            btn.className = 'copy-ehr-btn';
            btn.innerHTML = 'Copy';
            btn.onclick = () => { navigator.clipboard.writeText(bubble.innerText); };
            bubble.appendChild(btn);
        }
    } else {
        bubble.textContent = text;
    }
    chatArea.appendChild(bubble);
    chatArea.scrollTop = chatArea.scrollHeight;
}

const historyBtn = document.getElementById('history-btn');
const historyModal = document.getElementById('history-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const historyList = document.getElementById('history-list');
const historyFilterContainer = document.getElementById('history-filter-container');
const historyTabCurrent = document.getElementById('history-tab-current');
const historyTabPast = document.getElementById('history-tab-past');

let activeHistoryTab = 'current'; // 'current' or 'past'

async function fetchAndRenderHistory() {
    historyList.innerHTML = '<div class="spinner"></div> Loading dynamic encounters logs...';
    try {
        let url = `http://127.0.0.1:8000/doctor/${userId}/patients`;
        const filterByActive = currentPatientId && activeHistoryTab === 'current';

        if (filterByActive) {
            url = `http://127.0.0.1:8000/patient/${currentPatientId}/history?doctor_id=${userId}`;
        }

        const response = await fetch(url);

        if (response.status === 403) {
            historyList.innerHTML = '<p class="error">Access Denied: You do not have active consultation assignment or historical relationship for this patient\'s records.</p>';
            return;
        }

        const data = await response.json();
        const encounters = data.patients || data.encounters || [];
        loadedEncounters = encounters.map(e => ({
            ...e,
            encounter_id: e.encounter_id,
            patient_name: e.patient_name || valName.textContent
        }));

        historyList.innerHTML = '';

        if (encounters.length === 0) {
            historyList.innerHTML = '<p>No historical clinical consult logs found.</p>';
            return;
        }

        // Group encounters by patient name
        const patientGroup = {};
        encounters.forEach(e => {
            const name = e.patient_name || valName.textContent;
            if (!patientGroup[name]) {
                patientGroup[name] = [];
            }
            patientGroup[name].push(e);
        });

        // Loop through each patient group to render their dedicated card
        Object.entries(patientGroup).forEach(([patientName, pEncounters]) => {
            // Summarize all unique doctors who have treated this specific patient
            const patientDoctors = [];
            pEncounters.forEach(p => {
                if (p.doc_first && p.doc_last) {
                    const name = `Dr. ${p.doc_first} ${p.doc_last}`.trim();
                    if (name && !patientDoctors.includes(name)) {
                        patientDoctors.push(name);
                    }
                }
            });

            const patientDiv = document.createElement('div');
            patientDiv.style.marginBottom = '1rem';
            patientDiv.style.background = 'rgba(255, 255, 255, 0.05)';
            patientDiv.style.borderRadius = '12px';
            patientDiv.style.border = '1px solid rgba(255, 255, 255, 0.08)';
            patientDiv.style.overflow = 'hidden';

            const pIdSafe = patientName.replace(/[^a-zA-Z0-9]/g, '_');
            const consContainerId = `cons-container-${pIdSafe}`;

            // Patient Card Header (ONLY name and expander button)
            patientDiv.innerHTML = `
                <div style="padding: 1.2rem; background: rgba(255, 255, 255, 0.03); display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background 0.3s;"
                     onclick="togglePatientConsultations('${consContainerId}')">
                    <span style="font-weight: 700; font-size: 1.15rem; color: var(--primary-color); display: flex; align-items: center; gap: 8px;">
                         ${patientName}
                    </span>
                    <span id="arrow-${consContainerId}" style="font-size: 0.9rem; color: #86868b; transition: transform 0.3s; font-weight: 600;">▼ Expand (${pEncounters.length} visit${pEncounters.length > 1 ? 's' : ''})</span>
                </div>
                
                <div id="${consContainerId}" style="display: none; padding: 1.2rem; border-top: 1px solid rgba(255, 255, 255, 0.08); background: rgba(0, 0, 0, 0.1);">
                    ${patientDoctors.length > 0 ? `
                        <div style="margin-bottom: 1rem; padding: 0.6rem 0.8rem; background: rgba(0, 168, 150, 0.15); border-radius: 8px; border: 1px solid rgba(0, 168, 150, 0.2); color: #00a896; font-size: 0.85rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;">
                             Treating Practitioners: ${patientDoctors.join(', ')}
                        </div>
                    ` : ''}
                    <div id="cons-rows-${pIdSafe}" style="display: flex; flex-direction: column; gap: 1rem;">
                        <!-- Consultations list loaded here -->
                    </div>
                </div>
            `;

            historyList.appendChild(patientDiv);

            // Populate the consultations rows for this patient
            const rowsContainer = patientDiv.querySelector(`#cons-rows-${pIdSafe}`);
            pEncounters.forEach(p => {
                const rowDiv = document.createElement('div');
                rowDiv.style.background = 'rgba(255, 255, 255, 0.04)';
                rowDiv.style.border = '1px solid rgba(255, 255, 255, 0.06)';
                rowDiv.style.borderRadius = '8px';
                rowDiv.style.padding = '1rem';
                rowDiv.style.display = 'flex';
                rowDiv.style.flexDirection = 'column';
                rowDiv.style.gap = '0.8rem';

                const doctorName = (p.doc_first && p.doc_last) ? `Dr. ${p.doc_first} ${p.doc_last}` : 'Unknown Doctor';
                const formattedDate = new Date(p.created_at).toLocaleString();

                rowDiv.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; cursor: pointer;"
                         onclick="toggleConsultationDetails('notes-${p.encounter_id}', this)">
                        <div style="text-align: left; font-size: 0.95rem; font-weight: 600; color: #ffffff; display: flex; align-items: center; gap: 6px;">
                             Consultation on ${formattedDate} <span style="font-size: 0.85rem; color: #86868b; font-weight: 500;">(Treated by ${doctorName})</span>
                        </div>
                        <div style="display: flex; gap: 0.5rem; flex-shrink: 0;" onclick="event.stopPropagation();">
                            <button onclick="generateCertificate(${p.encounter_id})" class="btn btn-secondary"
                                style="padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; color: black; background: #e5e5ea; border:none; cursor:pointer;">
                                 MC
                            </button>
                            <button onclick="toggleInlineEdit(${p.encounter_id}, '${p.doc_id || ''}', this)" class="btn btn-secondary"
                                style="padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; color: black; background: #e5e5ea; border:none; cursor:pointer;">
                                 Edit Note
                            </button>
                        </div>
                    </div>
                    <div id="notes-${p.encounter_id}" style="display:none; padding:0.8rem; background:rgba(255,255,255,0.9); border-radius:8px; color: #1d1d1f;">
                        ${formatJsonStr(p.structured_notes_json)}
                    </div>
                `;
                rowsContainer.appendChild(rowDiv);
            });
        });
    } catch (err) {
        historyList.innerHTML = '<p class="error">Failed to parse encounter timeline stream profiles.</p>';
    }
}

if (historyTabCurrent && historyTabPast) {
    historyTabCurrent.addEventListener('click', () => {
        activeHistoryTab = 'current';
        historyTabCurrent.className = 'btn btn-primary';
        historyTabPast.className = 'btn btn-secondary';
        fetchAndRenderHistory();
    });

    historyTabPast.addEventListener('click', () => {
        activeHistoryTab = 'past';
        historyTabPast.className = 'btn btn-primary';
        historyTabCurrent.className = 'btn btn-secondary';
        fetchAndRenderHistory();
    });
}

historyBtn.addEventListener('click', async () => {
    historyModal.classList.remove('hidden');

    if (currentPatientId) {
        if (historyFilterContainer) historyFilterContainer.classList.remove('hidden');
        activeHistoryTab = 'current';
        if (historyTabCurrent) historyTabCurrent.className = 'btn btn-primary';
        if (historyTabPast) historyTabPast.className = 'btn btn-secondary';
    } else {
        if (historyFilterContainer) historyFilterContainer.classList.add('hidden');
        activeHistoryTab = 'past';
    }

    fetchAndRenderHistory();
});

closeModalBtn.addEventListener('click', () => historyModal.classList.add('hidden'));

window.toggleInlineEdit = async function (encounterId, docId, btnElement) {
    const notesContainer = document.getElementById(`notes-${encounterId}`);
    if (!notesContainer) return;

    const cells = notesContainer.querySelectorAll('.history-cell');

    if (btnElement.textContent.includes('Save Note')) {
        btnElement.innerHTML = 'Saving...';
        btnElement.disabled = true;

        const updatedNotes = {};
        cells.forEach(cell => {
            const key = cell.getAttribute('data-key');
            updatedNotes[key] = cell.innerText;
        });

        try {
            const response = await fetch(`http://127.0.0.1:8000/encounter/${encounterId}/notes`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    encounter_id: encounterId,
                    doc_id: docId || null,
                    updated_notes: updatedNotes,
                    patient_name: updatedNotes.name || 'Unknown Patient'
                })
            });

            const data = await response.json();
            if (data.success) {
                cells.forEach(cell => cell.removeAttribute('contenteditable'));
                btnElement.innerHTML = '✏️ Edit Note';
                btnElement.style.color = 'black';
                btnElement.style.background = '#e5e5ea';
                cdsHistory = [];

                const titleBtn = document.getElementById('title-btn-' + encounterId);
                if (titleBtn && updatedNotes.name) {
                    const timestamp = titleBtn.getAttribute('data-timestamp');
                    titleBtn.innerText = `▶ ${updatedNotes.name} (${new Date(timestamp).toLocaleString()})`;
                }
            }
        } catch (err) {
            alert('Error running update execution task context.');
        } finally {
            btnElement.disabled = false;
        }
    } else {
        cells.forEach(cell => cell.setAttribute('contenteditable', 'true'));
        btnElement.innerHTML = ' Save Note';
        btnElement.style.color = 'white';
        btnElement.style.background = '#28a745';
        if (notesContainer.style.display === 'none') notesContainer.style.display = 'block';
    }
};

// Medical Certificate issuance modal selectors
const mcModal = document.getElementById('mc-modal');
const closeMcBtn = document.getElementById('close-mc-btn');
const mcPatientName = document.getElementById('mc-patient-name');
const mcStartDate = document.getElementById('mc-start-date');
const mcEndDate = document.getElementById('mc-end-date');
const mcReason = document.getElementById('mc-reason');
const downloadMcBtn = document.getElementById('download-mc-btn');

let activeMcEncounterId = null;

if (closeMcBtn) {
    closeMcBtn.addEventListener('click', () => {
        mcModal.classList.add('hidden');
    });
}

window.generateCertificate = function (encounterId) {
    const encounter = loadedEncounters.find(e => e.encounter_id === encounterId);
    if (!encounter) {
        alert("Encounter not found.");
        return;
    }

    activeMcEncounterId = encounterId;

    let notes = {};
    try {
        notes = JSON.parse(encounter.structured_notes_json);
    } catch (e) { }

    mcPatientName.value = encounter.patient_name || 'Unknown Patient';

    const today = new Date().toISOString().substring(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().substring(0, 10);
    mcStartDate.value = today;
    mcEndDate.value = tomorrow;

    mcReason.value = notes.assessment && notes.assessment !== '--' ? notes.assessment : 'Medical Illness';

    historyModal.classList.add('hidden');
    mcModal.classList.remove('hidden');
};

if (downloadMcBtn) {
    downloadMcBtn.addEventListener('click', async () => {
        const encounter = loadedEncounters.find(e => e.encounter_id === activeMcEncounterId);
        if (!encounter) {
            alert("Active encounter not found.");
            return;
        }

        const patientName = mcPatientName.value.trim();
        const startDateVal = mcStartDate.value;
        const endDateVal = mcEndDate.value;
        const reasonVal = mcReason.value.trim() || 'Medical Illness';

        if (!startDateVal || !endDateVal) {
            alert("Please input valid dates.");
            return;
        }

        const start = new Date(startDateVal);
        const end = new Date(endDateVal);

        if (end < start) {
            alert("End date cannot be prior to start date.");
            return;
        }

        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        const formattedStart = start.toLocaleDateString('en-US', options);
        const formattedEnd = end.toLocaleDateString('en-US', options);
        const formattedVisit = new Date(encounter.created_at).toLocaleDateString('en-US', options);

        let notes = {};
        try {
            notes = JSON.parse(encounter.structured_notes_json);
        } catch (e) { }

        // Fetch Doctor Profile to display Registration/ID number & correct names
        let doctorIdNumber = 'PR-88291-A';
        let docFirstName = localStorage.getItem('first_name') || 'Mark';
        let docLastName = localStorage.getItem('last_name') || 'Schrieber';

        try {
            const drProfileResponse = await fetch(`http://127.0.0.1:8000/doctor/${userId}/profile`);
            const profileData = await drProfileResponse.json();
            if (profileData.success && profileData.profile) {
                doctorIdNumber = profileData.profile.id_number || 'PR-88291-A';
                if (profileData.profile.first_name) {
                    docFirstName = profileData.profile.first_name;
                }
                if (profileData.profile.last_name && profileData.profile.last_name !== 'null' && profileData.profile.last_name !== 'undefined') {
                    docLastName = profileData.profile.last_name;
                }
            }
        } catch (err) {
            console.error("Failed to fetch doctor profile:", err);
        }

        // Handle empty or null strings safely
        docFirstName = String(docFirstName).replace(/\bnull\b/gi, '').replace(/\bundefined\b/gi, '').trim();
        docLastName = String(docLastName).replace(/\bnull\b/gi, '').replace(/\bundefined\b/gi, '').trim() || 'Schrieber';

        const docName = `${docFirstName} ${docLastName}`.trim();

        const element = document.createElement('div');
        element.style.padding = '35px';
        element.style.fontFamily = "'DM Serif Display', serif";
        element.style.color = '#1e1e1e';
        element.style.border = '6px double #1a365d';
        element.style.width = '680px';
        element.style.background = 'white';
        element.style.boxSizing = 'border-box';
        element.style.position = 'relative';

        element.innerHTML = `
            <!-- Clinic Header -->
            <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1a365d; padding-bottom: 15px; margin-bottom: 25px;">
                <div style="display: flex; align-items: center; gap: 15px;">
                    <!-- Official System Logo (loaded as inline base64 to avoid local security errors) -->
                    <img src="${window.SYSTEM_LOGO_BASE64}" style="width: 60px; height: 60px; border-radius: 50%; object-fit: contain; flex-shrink: 0; background-color: transparent; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                    <div>
                        <h1 style="margin: 0; font-size: 26px; color: #1a365d; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Health Sync Clinic</h1>
                        <p style="margin: 3px 0 0 0; font-size: 11px; color: #4a5568; font-weight: 500;">12, Jalan Sultan Ismail, Kuala Lumpur, Malaysia</p>
                        <p style="margin: 0; font-size: 11px; color: #4a5568; font-weight: 500;">Tel: +60 3-2142 8888 | Email: contact@healthsync.my</p>
                    </div>
                </div>
                <div style="text-align: right;">
                    <h2 style="margin: 0; font-size: 18px; color: #2b6cb0; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">Medical Certificate</h2>
                    <p style="margin: 3px 0 0 0; font-size: 11px; color: #718096; font-family: 'DM Serif Display', serif;">Serial No: HS-MC-${encounter.encounter_id}-${Math.floor(1000 + Math.random() * 9000)}</p>
                </div>
            </div>

            <!-- Certificate Body -->
            <div style="margin-bottom: 40px; line-height: 1.8; font-size: 14.5px;">
                <p style="margin-bottom: 20px;"><strong>Date of Examination:</strong> ${formattedVisit}</p>
                
                <p style="margin-bottom: 25px;">This is to certify that I have clinically examined the following patient:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; background: rgba(0,0,0,0.01); border-radius: 4px;">
                    <tr>
                        <td style="padding: 8px 12px; width: 30%; color: #4a5568; font-weight: 600;">Patient Name:</td>
                        <td style="padding: 8px 12px; border-bottom: 1px solid #cbd5e0; color: #1e1e1e; font-weight: 700; font-size: 15px;">${patientName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 12px; color: #4a5568; font-weight: 600;">Identification:</td>
                        <td style="padding: 8px 12px; border-bottom: 1px solid #cbd5e0; color: #1e1e1e; font-family: 'DM Serif Display', serif;">${notes.ic_number || 'Patient Identity Verified'}</td>
                    </tr>
                </table>

                <p style="margin-bottom: 25px;">
                    In my professional opinion, the patient is diagnosed with <strong style="color: #2d3748; font-weight: 700;">${reasonVal}</strong> 
                    and is deemed medically unfit for duty.
                </p>
                
                <p style="margin-bottom: 30px;">
                    Accordingly, the patient has been granted sick leave for a period of 
                    <strong style="color: #2b6cb0; font-weight: 700; font-size: 16px;">${diffDays} Day(s)</strong>, 
                    commencing from <strong>${formattedStart}</strong> to <strong>${formattedEnd}</strong> (inclusive of both dates).
                </p>

                <p style="font-style: italic; font-size: 11.5px; color: #a0aec0; margin-top: 45px; line-height: 1.4;">
                    * This document is a formal Medical Certificate generated digitally by Health Sync EHR under the license and registration of the signing medical practitioner. Any unauthorized modification constitutes fraud.
                </p>
            </div>

            <!-- Doctor Signature Panel -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 60px; border-top: 1px solid #e2e8f0; padding-top: 25px;">
                <div>
                    <p style="margin: 0; font-size: 11px; color: #718096; text-transform: uppercase; letter-spacing: 0.5px;">Issued by:</p>
                    <p style="margin: 6px 0 0 0; font-size: 15px; font-weight: 700; color: #1a365d;">Dr. ${docName}</p>
                    <p style="margin: 2px 0 0 0; font-size: 12px; color: #4a5568; font-weight: 500;">MMC Registration No: ${doctorIdNumber}</p>
                    <p style="margin: 2px 0 0 0; font-size: 11px; color: #718096; font-style: italic;">Health Sync EHR Verified Scribe</p>
                </div>
                <div style="text-align: center; width: 220px; display: flex; flex-direction: column; align-items: center;">
                    <div style="font-family: 'DM Serif Display', serif; font-size: 26px; color: #2b6cb0; margin-bottom: -8px; transform: rotate(-3deg); font-style: italic; letter-spacing: 1px;">
                        Dr. ${docLastName || 'Mark'}
                    </div>
                    <div style="border-bottom: 2px solid #4a5568; margin-bottom: 6px; width: 100%;"></div>
                    <p style="margin: 0; font-size: 11px; color: #718096; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Authorized Signature</p>
                </div>
            </div>
        `;

        const opt = {
            margin: 10,
            filename: `HealthSync_MC_${patientName.replace(/\s+/g, '_')}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        try {
            downloadMcBtn.disabled = true;
            downloadMcBtn.innerText = ' Generating PDF...';

            await html2pdf().from(element).set(opt).save();

            downloadMcBtn.innerText = ' Download Complete';
            setTimeout(() => {
                downloadMcBtn.disabled = false;
                downloadMcBtn.innerText = ' Download MC PDF';
                mcModal.classList.add('hidden');
                historyModal.classList.remove('hidden');
            }, 1500);
        } catch (e) {
            alert("Failed to render PDF: " + e);
            downloadMcBtn.disabled = false;
            downloadMcBtn.innerText = ' Download MC PDF';
        }
    });
}

window.toggleNotes = function (id) {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.togglePatientConsultations = function (id) {
    const el = document.getElementById(id);
    const arrow = document.getElementById(`arrow-${id}`);
    if (el) {
        const isHidden = el.style.display === 'none';
        el.style.display = isHidden ? 'block' : 'none';
        if (arrow) {
            arrow.innerText = isHidden ? `▲ Collapse` : `▼ Expand`;
        }
    }
};

window.toggleConsultationDetails = function (id, headerElement) {
    const el = document.getElementById(id);
    if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
};

window.formatData = (val) => { return val || '--'; };

window.formatJsonStr = function (jsonStr) {
    try {
        const obj = JSON.parse(jsonStr);
        let tableHtml = '<table style="width: 100%; border-collapse: collapse; margin-top: 0.5rem; background: white; border-radius: 8px; overflow: hidden;"><tbody>';
        for (const [key, value] of Object.entries(obj)) {
            if (key.startsWith('_')) continue;
            const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            
            let valText = '';
            if (key === 'prescriptions' && Array.isArray(value)) {
                valText = value.map(p => `${p.drug} ${p.dosage} - ${p.frequency} (${p.duration})`).join(', ') || 'None';
            } else if (typeof value === 'object' && value !== null) {
                valText = JSON.stringify(value);
            } else {
                valText = value || 'N/A';
            }

            tableHtml += `
                <tr style="border-bottom: 1px solid #e5e5e5;">
                    <th style="padding: 0.8rem 1rem; text-align: left; width: 30%; color: #00a896; background: rgba(0, 168, 150, 0.05);">${formattedKey}</th>
                    <td class="history-cell" data-key="${key}" style="padding: 0.8rem 1rem; color: #1d1d1f;">${valText}</td>
                </tr>`;
        }
        tableHtml += '</tbody></table>';
        return tableHtml;
    } catch { return jsonStr; }
};

let active_patient_details = null;

async function pollQueue() {
    if (!userId) return;
    try {
        const response = await fetch(`http://127.0.0.1:8000/doctor/${userId}/on-hold`);
        const data = await response.json();

        const sidebarList = document.getElementById('sidebar-queue-list');

        if (data.patients && data.patients.length > 0) {
            queueRedDot.classList.remove('hidden');
            queueSection.classList.remove('hidden');

            queueList.innerHTML = '';
            if (sidebarList) sidebarList.innerHTML = '';

            data.patients.forEach(p => {
                // Render to dropdown list
                const item = document.createElement('div');
                item.className = 'queue-patient-item';
                item.innerHTML = `
                    <div class="queue-patient-info">
                        <span class="queue-patient-name">${p.patient_name}</span>
                        <span class="queue-patient-meta">${p.age} y/o, ${p.gender} | ID: ${p.ic_number}</span>
                    </div>
                `;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    loadPatient(p);
                });
                queueList.appendChild(item);

                // Render to sidebar list
                if (sidebarList) {
                    const sbItem = document.createElement('div');
                    sbItem.className = 'queue-patient-item';
                    sbItem.innerHTML = `
                        <div class="queue-patient-info">
                            <span class="queue-patient-name">${p.patient_name}</span>
                            <span class="queue-patient-meta">${p.age} y/o, ${p.gender} | ID: ${p.ic_number}</span>
                        </div>
                    `;
                    sbItem.addEventListener('click', (e) => {
                        e.stopPropagation();
                        loadPatient(p);
                    });
                    sidebarList.appendChild(sbItem);
                }
            });
        } else {
            queueRedDot.classList.add('hidden');
            queueSection.classList.add('hidden');
            queueList.innerHTML = '';
            if (sidebarList) {
                sidebarList.innerHTML = '<p class="placeholder-text">No patients in queue.</p>';
            }
        }
    } catch (err) {
        console.error('Error polling doctor queue:', err);
    }
}

function loadPatient(patient) {
    currentPatientId = patient.id;
    active_patient_details = patient;

    // Close the dropdown menu
    headerDropdown.classList.remove('show');
    headerDropdown.classList.add('hidden');

    // Populate demographic fields and lock them
    valName.textContent = patient.patient_name;
    valName.setAttribute('contenteditable', 'false');

    valAge.textContent = patient.age;
    valAge.setAttribute('contenteditable', 'false');

    valGender.textContent = patient.gender;
    valGender.setAttribute('contenteditable', 'false');

    // Populate the demographics horizontal safety banner
    const demoBanner = document.getElementById('demographics-banner');
    if (demoBanner) {
        document.getElementById('banner-name').textContent = patient.patient_name;
        document.getElementById('banner-age').textContent = patient.age;
        document.getElementById('banner-gender').textContent = patient.gender;
        document.getElementById('banner-ic').textContent = patient.ic_number || 'N/A';
        
        // Safety alerts defaults (editable by clinician in contenteditable spans)
        document.getElementById('banner-allergies').textContent = "Allergies: None";
        document.getElementById('banner-vitals').textContent = "BP: 120/80 | HR: 72";
        
        demoBanner.classList.remove('hidden');
    }

    // Clear clinical note fields for fresh consultation
    valSubjective.textContent = '--';
    valObjective.textContent = '--';
    valAssessment.textContent = '--';
    valPlan.textContent = '--';

    // Reset prescription builder and signature state
    window.unlockConsultationWorkspace();

    // Clear active encounter
    currentEncounterId = null;
    currentDocId = null;
    const saveBtn = document.getElementById('save-notes-btn');
    if (saveBtn) {
        saveBtn.classList.remove('hidden');
        saveBtn.innerHTML = '<span class="icon">💾</span> Save Consultation';
    }

    alert(`Active consultation assigned for: ${patient.patient_name}`);
}

// Sidebar Toggle Event Listener
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const queueSidebar = document.getElementById('queue-sidebar');
if (toggleSidebarBtn && queueSidebar) {
    toggleSidebarBtn.addEventListener('click', () => {
        queueSidebar.classList.toggle('collapsed');
    });
}

// Prescription Helper functions
window.addPrescriptionRow = function(drugName = '', dosage = '', frequency = '', duration = '') {
    const list = document.getElementById('prescription-list');
    if (!list) return;

    const row = document.createElement('div');
    row.className = 'prescription-row';
    row.innerHTML = `
        <input type="text" placeholder="e.g. Amoxicillin" value="${drugName}" class="presc-drug">
        <input type="text" placeholder="e.g. 500mg" value="${dosage}" class="presc-dosage">
        <input type="text" placeholder="e.g. BD (Twice daily)" value="${frequency}" class="presc-freq">
        <input type="text" placeholder="e.g. 7 Days" value="${duration}" class="presc-duration">
        <button class="delete-presc-btn" onclick="this.parentElement.remove()" type="button" title="Delete">✕</button>
    `;
    list.appendChild(row);
};

const addPrescBtn = document.getElementById('add-prescription-btn');
if (addPrescBtn) {
    addPrescBtn.addEventListener('click', () => {
        window.addPrescriptionRow();
    });
}

window.triggerDigitallySignedState = function() {
    const overlay = document.getElementById('signature-stamp-overlay');
    if (overlay) {
        const stampDate = document.getElementById('signature-stamp-date');
        if (stampDate) {
            stampDate.textContent = new Date().toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
        }
        overlay.classList.remove('hidden');
    }
    // Lock note fields
    ['val-subjective', 'val-objective', 'val-assessment', 'val-plan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('contenteditable', 'false');
    });
    // Lock prescription inputs
    document.querySelectorAll('.prescription-row input').forEach(input => {
        input.disabled = true;
    });
    document.querySelectorAll('.delete-presc-btn').forEach(btn => {
        btn.style.display = 'none';
    });
    const addPrescBtnEl = document.getElementById('add-prescription-btn');
    if (addPrescBtnEl) addPrescBtnEl.style.display = 'none';
};

window.unlockConsultationWorkspace = function() {
    const overlay = document.getElementById('signature-stamp-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
    // Unlock note fields
    ['val-subjective', 'val-objective', 'val-assessment', 'val-plan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('contenteditable', 'true');
    });
    // Enable prescription additions
    const addPrescBtnEl = document.getElementById('add-prescription-btn');
    if (addPrescBtnEl) addPrescBtnEl.style.display = 'inline-flex';
    
    // Clear prescriptions
    const prescList = document.getElementById('prescription-list');
    if (prescList) prescList.innerHTML = '';
};

// Start queue polling
pollQueue();
setInterval(pollQueue, 10000);