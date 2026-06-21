document.addEventListener('DOMContentLoaded', () => {
    const userId = AppStorage.getItem('user_id');
    if (!userId) {
        window.location.href = 'login.html';
        return;
    }

    const backBtn = document.getElementById('back-btn');
    const saveBtn = document.getElementById('save-btn');
    const msgDiv = document.getElementById('profile-message');

    // Update password label to clarify it's optional
    const passwordInput = document.getElementById('password');
    if (passwordInput) {
        passwordInput.placeholder = 'Leave blank to keep current password';
    }

    backBtn.addEventListener('click', () => {
        const role = AppStorage.getItem('role');
        window.location.href = role === 'admin' ? 'admin.html' : 'index.html';
    });

    loadProfile(userId);

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        msgDiv.textContent = 'Saving...';
        msgDiv.className = '';

        const payload = {
            username: document.getElementById('username').value.trim(),
            password: document.getElementById('password').value.trim(), // Empty string = keep existing
            first_name: document.getElementById('first_name').value.trim(),
            last_name: document.getElementById('last_name').value.trim(),
            id_number: document.getElementById('id_number').value.trim(),
            specialty: document.getElementById('specialty').value.trim()
        };

        try {
            const response = await fetch(`http://127.0.0.1:8000/doctor/${userId}/profile`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.success) {
                msgDiv.textContent = data.message;
                msgDiv.className = 'success';
                AppStorage.setItem('username', payload.username);
                if (payload.first_name) {
                    AppStorage.setItem('first_name', payload.first_name);
                } else {
                    AppStorage.removeItem('first_name');
                }
                // Clear password field after save
                document.getElementById('password').value = '';
            } else {
                msgDiv.textContent = data.message;
                msgDiv.className = 'error';
            }
        } catch (err) {
            msgDiv.textContent = 'Network error.';
            msgDiv.className = 'error';
        } finally {
            saveBtn.disabled = false;
            setTimeout(() => {
                if (msgDiv.className === 'success') msgDiv.textContent = '';
            }, 3000);
        }
    });
});

async function loadProfile(userId) {
    try {
        const response = await fetch(`http://127.0.0.1:8000/doctor/${userId}/profile`);
        const data = await response.json();

        if (data.success && data.profile) {
            const p = data.profile;
            document.getElementById('username').value = p.username || '';
            // FIX: Password is never returned from the backend — leave field empty
            document.getElementById('password').value = '';
            document.getElementById('first_name').value = p.first_name || '';
            document.getElementById('last_name').value = p.last_name || '';
            document.getElementById('id_number').value = p.id_number || '';
            document.getElementById('specialty').value = p.specialty || '';
        }
    } catch (err) {
        console.error('Error loading profile:', err);
    }
}