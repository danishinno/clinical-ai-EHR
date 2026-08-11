const userId = AppStorage.getItem('user_id');
const role = AppStorage.getItem('role');
if (!userId) {
    window.location.href = 'login.html';
} else if (role === 'admin') {
    window.location.href = 'admin.html';
}

document.getElementById('dr-name-display').textContent = AppStorage.getItem('first_name') || AppStorage.getItem('username') || '';

document.getElementById('logout-btn').addEventListener('click', () => {
    AppStorage.clear();
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
        const wsHost = window.location.hostname || '127.0.0.1';
        socket = new WebSocket(`ws://${wsHost}:8000/live-transcribe`);

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
        const response = await fetch('${window.API_BASE_URL}/process-dictation', {
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
                const response = await fetch(`${window.API_BASE_URL}/encounter/${currentEncounterId}/notes`, {
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
                    window.lockActiveWorkspace();
                    cdsHistory = [];
                    setTimeout(() => {
                        saveNotesBtn.innerHTML = '<span class="icon"></span> Saved & Locked';
                    }, 2000);
                } else {
                    alert('Error updating consultation: ' + result.message);
                    saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                    saveNotesBtn.disabled = false;
                }
            } catch (err) {
                alert('Failed to execute update sequence pipeline.');
                saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                saveNotesBtn.disabled = false;
            }
        } else if (currentPatientId) {
            try {
                saveNotesBtn.disabled = true;
                saveNotesBtn.innerHTML = 'Saving...';

                const response = await fetch(`${window.API_BASE_URL}/encounter/save`, {
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

                    saveNotesBtn.innerHTML = '<span class="icon"></span> Saved';
                    window.lockActiveWorkspace();
                    cdsHistory = [];

                    if (typeof pollQueue === 'function') pollQueue();

                    setTimeout(() => {
                        saveNotesBtn.innerHTML = '<span class="icon"></span> Saved & Locked';
                    }, 2000);
                } else {
                    alert('Error creating consultation: ' + result.message);
                    saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
                    saveNotesBtn.disabled = false;
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

const refineSoapBtn = document.getElementById('refine-soap-btn');
const manualAdditionsInput = document.getElementById('manual-additions-input');

if (refineSoapBtn && manualAdditionsInput) {
    refineSoapBtn.addEventListener('click', async () => {
        const text = manualAdditionsInput.value.trim();
        if (!text) {
            alert('Please enter some additions or corrections first.');
            return;
        }

        try {
            refineSoapBtn.disabled = true;
            refineSoapBtn.innerText = 'Refining...';

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

            const currentNotes = {
                name: valName.textContent.trim(),
                age: valAge.textContent.trim(),
                gender: valGender.textContent.trim(),
                subjective: valSubjective.textContent.trim(),
                objective: valObjective.textContent.trim(),
                assessment: valAssessment.textContent.trim(),
                plan: valPlan.textContent.trim(),
                prescriptions: prescriptions
            };

            const response = await fetch('${window.API_BASE_URL}/encounter/refine', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    current_notes: currentNotes,
                    additional_text: text
                })
            });

            const result = await response.json();
            if (result.success && result.updated_notes) {
                const notes = result.updated_notes;
                
                // Update text fields
                valName.textContent = notes.name || valName.textContent;
                valAge.textContent = notes.age || valAge.textContent;
                valGender.textContent = notes.gender || valGender.textContent;
                valSubjective.textContent = notes.subjective || valSubjective.textContent;
                valObjective.textContent = notes.objective || valObjective.textContent;
                valAssessment.textContent = notes.assessment || valAssessment.textContent;
                valPlan.textContent = notes.plan || valPlan.textContent;

                // Update Prescriptions if returned
                if (notes.prescriptions) {
                    const prescList = document.getElementById('prescription-list');
                    if (prescList) {
                        prescList.innerHTML = '';
                        notes.prescriptions.forEach(p => {
                            window.addPrescriptionRow(p.drug, p.dosage, p.frequency, p.duration);
                        });
                    }
                }

                // Clear input
                manualAdditionsInput.value = '';
                alert('SOAP notes updated successfully!');
            } else {
                alert('Failed to refine notes: ' + (result.message || 'Unknown error'));
            }
        } catch (err) {
            console.error('Error refining SOAP notes:', err);
            alert('Network error while refining notes.');
        } finally {
            refineSoapBtn.disabled = false;
            refineSoapBtn.innerText = 'Integrate Notes';
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
        const response = await fetch('${window.API_BASE_URL}/ask-guidelines', {
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
    if (cdsLoading && chatArea.contains(cdsLoading)) {
        chatArea.insertBefore(bubble, cdsLoading);
    } else {
        chatArea.appendChild(bubble);
    }
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
        let url = `${window.API_BASE_URL}/doctor/${userId}/patients`;
        const filterByActive = currentPatientId && activeHistoryTab === 'current';

        if (filterByActive) {
            url = `${window.API_BASE_URL}/patient/${currentPatientId}/history?doctor_id=${userId}`;
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

                const createdTime = new Date(p.created_at);
                const now = new Date();
                const diffMs = now - createdTime;
                const diffHours = diffMs / (1000 * 60 * 60);
                const isToday = createdTime.toDateString() === now.toDateString();
                const canGenerateMC = isToday && (diffHours <= 2);

                const addendumHtml = p.additional_notes ? `
                    <div class="addendum-box">
                        <strong>Addendum / Additional Notes</strong>
                        ${p.additional_notes.replace(/\n/g, '<br>')}
                    </div>
                ` : '';

                rowDiv.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; cursor: pointer;"
                         onclick="toggleConsultationDetails('notes-${p.encounter_id}', this)">
                        <div style="text-align: left; font-size: 0.95rem; font-weight: 600; color: #ffffff; display: flex; align-items: center; gap: 6px;">
                             Consultation on ${formattedDate} <span style="font-size: 0.85rem; color: #86868b; font-weight: 500;">(Treated by ${doctorName})</span>
                        </div>
                        <div style="display: flex; gap: 0.5rem; flex-shrink: 0;" onclick="event.stopPropagation();">
                            ${canGenerateMC ? `
                            <button onclick="generateCertificate(${p.encounter_id})" class="btn btn-secondary"
                                style="padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; color: black; background: #e5e5ea; border:none; cursor:pointer;"
                                title="Issue Medical Certificate">
                                 MC
                            </button>
                            ` : `
                            <button class="btn btn-secondary" disabled
                                title="MC can only be generated within 2 hours of today's consultation"
                                style="padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; color: rgba(255, 255, 255, 0.35); background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); cursor:not-allowed;">
                                 MC
                            </button>
                            `}
                            ${p.is_finalized === 1 ? `
                            <button onclick="toggleAddendumEdit(${p.encounter_id}, '${p.doc_id || ''}', this)" class="btn btn-secondary"
                                style="padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; color: black; background: #e5e5ea; border:none; cursor:pointer;">
                                 Add Addendum
                            </button>
                            ` : `
                            <button onclick="toggleInlineEdit(${p.encounter_id}, '${p.doc_id || ''}', this)" class="btn btn-secondary"
                                style="padding: 0.3rem 0.6rem; font-size: 0.8rem; border-radius: 20px; color: black; background: #e5e5ea; border:none; cursor:pointer;">
                                 Edit Note
                            </button>
                            `}
                        </div>
                    </div>
                    <div id="notes-${p.encounter_id}" style="display:none; padding:0.8rem; background:rgba(255,255,255,0.9); border-radius:8px; color: #1d1d1f;">
                        ${formatJsonStr(p.structured_notes_json)}
                        ${addendumHtml}
                        <div id="addendum-edit-area-${p.encounter_id}" style="display:none; margin-top:0.8rem; padding-top:0.8rem; border-top:1px solid #e5e5e5; text-align: left;">
                            <label style="font-size:0.8rem; font-weight:600; color:#555; display: block; margin-bottom: 0.3rem;">Append Additional Consultation Notes / Addendum:</label>
                            <textarea id="addendum-input-${p.encounter_id}" class="addendum-textarea" placeholder="Type additional medical findings or notes here...">${p.additional_notes || ''}</textarea>
                        </div>
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
            const response = await fetch(`${window.API_BASE_URL}/encounter/${encounterId}/notes`, {
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
                btnElement.innerHTML = 'Edit Note';
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
        let docFirstName = AppStorage.getItem('first_name') || 'Mark';
        let docLastName = AppStorage.getItem('last_name') || 'Schrieber';

        try {
            const drProfileResponse = await fetch(`${window.API_BASE_URL}/doctor/${userId}/profile`);
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

        const serialSuffix = Math.floor(1000 + Math.random() * 9000);
        const serialNumber = `HS-MC-${encounter.encounter_id}-${serialSuffix}`;

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
                    <p style="margin: 3px 0 0 0; font-size: 11px; color: #718096; font-family: 'DM Serif Display', serif;">Serial No: HS-MC-${encounter.encounter_id}-${serialSuffix}</p>
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

        try {
            downloadMcBtn.disabled = true;
            downloadMcBtn.innerText = ' Generating PDF...';

            const mcHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Medical Certificate - ${patientName}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Serif Display',serif;background:#fff;color:#1e1e1e;padding:35px;font-size:14px}
  @media print{@page{margin:10mm;size:A4 portrait}body{padding:0}}
</style>
</head>
<body>
${element.outerHTML}
<script>window.onload=function(){window.print()};<\/script>
</body>
</html>`;

            const win = window.open('', '_blank', 'width=800,height=1050,scrollbars=yes');
            if (!win) {
                alert('Popup blocked! Please allow popups for localhost:8080 and try again.');
                downloadMcBtn.disabled = false;
                downloadMcBtn.innerText = ' Download MC PDF';
                return;
            }
            win.document.write(mcHtml);
            win.document.close();

            // ── Silently save MC to DB for admin audit trail ──
            try {
                await fetch('${window.API_BASE_URL}/save-certificate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        serial_number: serialNumber,
                        encounter_id: encounter.encounter_id,
                        patient_id: encounter.patient_id || currentPatientId || 0,
                        doctor_id: parseInt(userId),
                        patient_name: patientName,
                        ic_number: notes.ic_number || '',
                        diagnosis: reasonVal,
                        rest_start: startDateVal,
                        rest_end: endDateVal,
                        days_issued: diffDays,
                        html_content: element.outerHTML
                    })
                });
            } catch (saveErr) {
                console.warn('[MC] Could not save certificate to audit log:', saveErr);
            }

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
        const response = await fetch(`${window.API_BASE_URL}/doctor/${userId}/on-hold`);
        const data = await response.json();

        const sidebarList = document.getElementById('sidebar-queue-list');
        const statsCount = document.getElementById('stats-queue-count');
        const completedCountEl = document.getElementById('stats-completed-count');

        // Fetch completed consultations count dynamically
        try {
            const historyResponse = await fetch(`${window.API_BASE_URL}/doctor/${userId}/patients`);
            const historyData = await historyResponse.json();
            const encounters = historyData.patients || historyData.encounters || [];
            if (completedCountEl) completedCountEl.innerText = encounters.length;
        } catch (e) {
            console.error('Error updating completed count:', e);
        }

        if (data.patients && data.patients.length > 0) {
            if (statsCount) statsCount.innerText = data.patients.length;
            if (queueRedDot) queueRedDot.classList.remove('hidden');

            if (sidebarList) sidebarList.innerHTML = '';

            data.patients.forEach(p => {
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
            if (statsCount) statsCount.innerText = '0';
            if (queueRedDot) queueRedDot.classList.add('hidden');
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
        saveBtn.innerHTML = '<span class="icon"></span> Save Consultation';
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



window.unlockConsultationWorkspace = function() {
    // Ensure SOAP fields are always editable
    ['val-subjective', 'val-objective', 'val-assessment', 'val-plan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('contenteditable', 'true');
    });
    // Re-enable prescription additions
    const addPrescBtnEl = document.getElementById('add-prescription-btn');
    if (addPrescBtnEl) addPrescBtnEl.style.display = 'inline-flex';
    // Clear prescriptions
    const prescList = document.getElementById('prescription-list');
    if (prescList) prescList.innerHTML = '';
    
    // Unlock refiner input and buttons
    const refineBtn = document.getElementById('refine-soap-btn');
    if (refineBtn) refineBtn.disabled = false;
    const refineInput = document.getElementById('manual-additions-input');
    if (refineInput) {
        refineInput.disabled = false;
        refineInput.value = '';
    }
    const saveNotesBtn = document.getElementById('save-notes-btn');
    if (saveNotesBtn) {
        saveNotesBtn.disabled = false;
        saveNotesBtn.style.opacity = '1';
        saveNotesBtn.style.cursor = 'pointer';
        saveNotesBtn.innerHTML = '<span class="icon"></span> Save Consultation';
    }
};

window.lockActiveWorkspace = function() {
    // Lock SOAP fields
    ['val-subjective', 'val-objective', 'val-assessment', 'val-plan'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.setAttribute('contenteditable', 'false');
    });
    // Hide prescription buttons
    const addPrescBtnEl = document.getElementById('add-prescription-btn');
    if (addPrescBtnEl) addPrescBtnEl.style.display = 'none';
    document.querySelectorAll('.delete-presc-btn').forEach(btn => btn.style.display = 'none');
    // Lock prescription input fields
    document.querySelectorAll('.prescription-row input').forEach(input => input.disabled = true);
    // Disable manual refiner
    const refineBtn = document.getElementById('refine-soap-btn');
    if (refineBtn) refineBtn.disabled = true;
    const refineInput = document.getElementById('manual-additions-input');
    if (refineInput) refineInput.disabled = true;
    // Disable save notes button
    const saveNotesBtn = document.getElementById('save-notes-btn');
    if (saveNotesBtn) {
        saveNotesBtn.disabled = true;
        saveNotesBtn.style.opacity = '0.5';
        saveNotesBtn.style.cursor = 'not-allowed';
    }
};

window.toggleAddendumEdit = async function (encounterId, docId, btnElement) {
    const notesContainer = document.getElementById(`notes-${encounterId}`);
    if (!notesContainer) return;

    const editArea = document.getElementById(`addendum-edit-area-${encounterId}`);
    const inputField = document.getElementById(`addendum-input-${encounterId}`);
    if (!editArea || !inputField) return;

    if (btnElement.textContent.includes('Save Addendum')) {
        btnElement.innerHTML = 'Saving...';
        btnElement.disabled = true;

        const textValue = inputField.value.trim();
        try {
            const response = await fetch(`${window.API_BASE_URL}/encounter/${encounterId}/notes`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    encounter_id: encounterId,
                    doc_id: docId || null,
                    patient_name: valName.textContent || 'Unknown Patient',
                    additional_notes: textValue
                })
            });

            const data = await response.json();
            if (data.success) {
                btnElement.innerHTML = 'Add Addendum';
                btnElement.style.color = 'black';
                btnElement.style.background = '#e5e5ea';
                editArea.style.display = 'none';
                await fetchAndRenderHistory();
            } else {
                alert('Error saving addendum: ' + data.message);
                btnElement.innerHTML = 'Save Addendum';
            }
        } catch (err) {
            alert('Failed to save addendum notes.');
            btnElement.innerHTML = 'Save Addendum';
        } finally {
            btnElement.disabled = false;
        }
    } else {
        editArea.style.display = 'block';
        btnElement.innerHTML = 'Save Addendum';
        btnElement.style.color = 'white';
        btnElement.style.background = '#28a745';
        if (notesContainer.style.display === 'none') {
            notesContainer.style.display = 'block';
        }
        inputField.focus();
    }
};

// --- Monthly Report Modal Logic ---
const reportModal = document.getElementById('report-modal');
const reportBtn = document.getElementById('report-btn');
const closeReportBtn = document.getElementById('close-report-btn');
const loadReportBtn = document.getElementById('load-report-btn');
const reportMonthSelect = document.getElementById('report-month-select');

// ── Month / Year pickers (Report Modal) ──────────────────────────────────
const reportMonthPicker = document.getElementById('report-month-picker');
const reportYearPicker  = document.getElementById('report-year-picker');

if (reportMonthPicker && reportYearPicker) {
    const now = new Date();
    const curYear  = now.getFullYear();
    const curMonth = String(now.getMonth() + 1).padStart(2, '0');

    // Populate years: current year down to 2024
    for (let y = curYear; y >= 2024; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        if (y === curYear) opt.selected = true;
        reportYearPicker.appendChild(opt);
    }

    // Pre-select current month
    reportMonthPicker.value = curMonth;

    // Reload report automatically on selection change
    reportMonthPicker.addEventListener('change', () => window.loadMonthlyReport(false));
    reportYearPicker.addEventListener('change', () => window.loadMonthlyReport(false));
}

if (reportBtn) {
    reportBtn.addEventListener('click', () => {
        const headerDropdown = document.getElementById('header-dropdown');
        if (headerDropdown) headerDropdown.classList.add('hidden');
        if (reportModal) reportModal.classList.remove('hidden');
        window.loadMonthlyReport();
    });
}

if (closeReportBtn) {
    closeReportBtn.addEventListener('click', () => {
        if (reportModal) reportModal.classList.add('hidden');
    });
}

if (loadReportBtn) {
    loadReportBtn.addEventListener('click', () => {
        window.loadMonthlyReport(true);
    });
}

window.loadMonthlyReport = async function(shouldDownload = false) {
    // Read directly from dropdowns — no hidden input sync needed
    let selectedMonth = '';
    if (reportMonthPicker && reportYearPicker) {
        const m = reportMonthPicker.value || String(new Date().getMonth() + 1).padStart(2, '0');
        const y = reportYearPicker.value  || new Date().getFullYear();
        selectedMonth = `${y}-${m}`;
    } else if (reportMonthSelect) {
        selectedMonth = reportMonthSelect.value;
    }

    let url = `${window.API_BASE_URL}/report/monthly`;
    const params = [];
    if (selectedMonth) {
        params.push(`month=${selectedMonth}`);
    }
    if (userId) {
        params.push(`doctor_id=${userId}`);
    }
    if (params.length > 0) {
        url += '?' + params.join('&');
    }
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.success) {
            document.getElementById('report-total-visits').innerText = data.summary.total_visits;
            document.getElementById('report-total-prescriptions').innerText = data.summary.total_prescriptions;
            
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
                        row.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        row.innerHTML = `
                            <span style="font-weight:600; color:#ffffff;">${d.doctor_name}</span>
                            <span style="color:var(--primary-color); font-weight:700;">${d.visit_count} consults</span>
                        `;
                        docList.appendChild(row);
                    });
                } else {
                    docList.innerHTML = '<p class="placeholder-text" style="padding:0.5rem 0;">No consultation records for this month.</p>';
                }
            }
            
            // Render Top Prescribed Drugs
            const drugList = document.getElementById('report-top-drugs-list');
            if (drugList) {
                drugList.innerHTML = '';
                if (data.summary.top_drugs && data.summary.top_drugs.length > 0) {
                    data.summary.top_drugs.forEach(dr => {
                        const row = document.createElement('div');
                        row.style.display = 'flex';
                        row.style.justifyContent = 'space-between';
                        row.style.padding = '0.5rem 0';
                        row.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        row.innerHTML = `
                            <span style="font-weight:600; color:#ffffff;">${dr.drug}</span>
                            <span style="color:var(--danger-color); font-weight:700;">${dr.count} times</span>
                        `;
                        drugList.appendChild(row);
                    });
                } else {
                    drugList.innerHTML = '<p class="placeholder-text" style="padding:0.5rem 0;">No prescriptions recorded for this month.</p>';
                }
            }
            
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
                        row.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                        row.innerHTML = `
                            <span style="color:var(--text-muted); width: 90px; flex-shrink: 0; font-size: 0.85rem;">${day.date}</span>
                            <div style="flex-grow: 1; margin: 0 1rem; height: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 4px; overflow: hidden; position: relative;">
                                <div style="width: ${percentage}%; height: 100%; background: var(--primary-color); border-radius: 4px;"></div>
                            </div>
                            <span style="color:#ffffff; font-weight:600; width: 60px; text-align: right; font-size: 0.85rem;">${day.visit_count} visits</span>
                        `;
                        dailyList.appendChild(row);
                    });
                } else {
                    dailyList.innerHTML = '<p class="placeholder-text" style="padding: 0.5rem 0;">No data.</p>';
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
};

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

    const drugRows = (data.summary.top_drugs && data.summary.top_drugs.length > 0)
        ? data.summary.top_drugs.map(dr => `
            <div class="row-item">
                <span class="row-label">${dr.drug}</span>
                <span class="row-value red">${dr.count} times</span>
            </div>`).join('')
        : '<p class="empty-note">No prescriptions recorded.</p>';

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
      <div class="card-label">Total Prescriptions Issued</div>
      <div class="card-value red">${data.summary.total_prescriptions}</div>
    </div>
  </div>
  <div class="split">
    <div class="box wide">
      <div class="box-title">Consultations by Medical Officer</div>
      ${docRows}
    </div>
    <div class="box narrow">
      <div class="box-title">Top Prescribed Medications</div>
      ${drugRows}
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

// Start queue polling
pollQueue();
setInterval(pollQueue, 10000);

// Live Developer Console / Backend log monitor
function initDevLogConsole() {
    const container = document.createElement('div');
    container.innerHTML = `
        <div id="dev-console-toggle" class="dev-console-toggle" title="Toggle Backend Dev Monitor">
            <span class="dev-console-pulse"></span>
            LOGS
        </div>
        <div id="dev-console-panel" class="dev-console-panel hidden">
            <div class="dev-console-header">
                <h3><span class="dev-console-pulse"></span> Live Backend Monitor</h3>
                <button id="close-dev-console-btn" style="background:none; border:none; color:#8f92a1; font-size:1.1rem; cursor:pointer; font-weight:bold; padding: 0;">✕</button>
            </div>
            <div id="dev-console-body" class="dev-console-body">
                <div class="log-line sys">[SYSTEM] Connecting to backend log server...</div>
            </div>
        </div>
    `;
    document.body.appendChild(container);

    const toggleBtn = document.getElementById('dev-console-toggle');
    const panel = document.getElementById('dev-console-panel');
    const closeBtn = document.getElementById('close-dev-console-btn');
    const consoleBody = document.getElementById('dev-console-body');

    toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            consoleBody.scrollTop = consoleBody.scrollHeight;
        }
    });

    closeBtn.addEventListener('click', () => {
        panel.classList.add('hidden');
    });

    let logSocket;
    function connectLogs() {
        // Connect to local loopback backend logs endpoint
        logSocket = new WebSocket('ws://127.0.0.1:8000/backend-logs');

        logSocket.onopen = () => {
            appendLogLine('[SYSTEM] Connected to Live Backend Monitor.', 'sys');
        };

        logSocket.onmessage = (event) => {
            const message = event.data;
            if (message) {
                let type = 'info';
                if (message.includes('[Clinical Brain]') || message.includes('[Dictation Scribe]') || message.includes('[Encounter Update]') || message.includes('[Manual Save]') || message.includes('[Patient History API]')) {
                    type = 'sys';
                } else if (message.includes('Error') || message.includes('failed') || message.includes('Exception') || message.includes('FAIL') || message.includes('HTTPException')) {
                    type = 'err';
                } else if (message.includes('WARNING') || message.includes('⚠️')) {
                    type = 'warn';
                }
                appendLogLine(message, type);
            }
        };

        logSocket.onclose = () => {
            appendLogLine('[SYSTEM] Connection lost. Reconnecting in 3s...', 'err');
            setTimeout(connectLogs, 3000);
        };

        logSocket.onerror = () => {
            logSocket.close();
        };
    }

    function appendLogLine(text, type) {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = text;
        consoleBody.appendChild(line);

        while (consoleBody.childElementCount > 400) {
            consoleBody.removeChild(consoleBody.firstChild);
        }

        consoleBody.scrollTop = consoleBody.scrollHeight;
    }

    connectLogs();
}

window.addEventListener('DOMContentLoaded', () => {
    initDevLogConsole();
});
