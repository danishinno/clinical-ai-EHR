const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const firstNameInput = document.getElementById('first_name');
const lastNameInput = document.getElementById('last_name');
const idNumberInput = document.getElementById('id_number');
const submitBtn = document.getElementById('submit-btn');
const toggleMode = document.getElementById('toggle-mode');
const formTitle = document.getElementById('form-title');
const authMessage = document.getElementById('auth-message');
const signupElements = document.querySelectorAll('.signup-only');

window.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        submitBtn.click();
    }
});

const toggleReset = document.getElementById('toggle-reset');

let currentMode = 'login'; // 'login', 'signup', 'reset'

function updateUI() {
    authMessage.textContent = '';
    if (currentMode === 'login') {
        formTitle.textContent = 'Welcome Back';
        submitBtn.textContent = 'Login';
        toggleMode.textContent = "Don't have an account? Sign up (Doctors only)";
        toggleReset.style.display = 'block';
        signupElements.forEach(el => el.style.display = 'none');
        passwordInput.previousElementSibling.textContent = 'Password';
        passwordInput.placeholder = 'Enter your password';
    } else if (currentMode === 'signup') {
        formTitle.textContent = 'Doctor Sign Up';
        submitBtn.textContent = 'Create Account';
        toggleMode.textContent = "Already have an account? Login";
        toggleReset.style.display = 'none';
        signupElements.forEach(el => el.style.display = 'block');
        passwordInput.previousElementSibling.textContent = 'Password';
        passwordInput.placeholder = 'Enter your password';
    } else if (currentMode === 'reset') {
        formTitle.textContent = 'Reset Password';
        submitBtn.textContent = 'Reset Password';
        toggleMode.textContent = "Back to Login";
        toggleReset.style.display = 'none';
        signupElements.forEach(el => el.style.display = 'none');
        passwordInput.previousElementSibling.textContent = 'New Password';
        passwordInput.placeholder = 'Enter your new password';
    }
}

toggleMode.addEventListener('click', () => {
    currentMode = (currentMode === 'signup' || currentMode === 'reset') ? 'login' : 'signup';
    updateUI();
});

toggleReset.addEventListener('click', () => {
    currentMode = 'reset';
    updateUI();
});

function showMessage(msg, isSuccess) {
    authMessage.textContent = msg;
    authMessage.className = isSuccess ? 'success' : 'error';
}

submitBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
        showMessage('Please enter username and password.', false);
        return;
    }

    let endpoint = '';
    if (currentMode === 'login') endpoint = '/login';
    else if (currentMode === 'signup') endpoint = '/signup';
    else if (currentMode === 'reset') endpoint = '/reset-password';
    
    submitBtn.disabled = true;

    const payload = { username, password };
    if (currentMode === 'signup') {
        payload.first_name = firstNameInput.value.trim();
        payload.last_name = lastNameInput.value.trim();
        payload.id_number = idNumberInput.value.trim();
    }

    try {
        const response = await fetch(`${window.API_BASE_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();

        if (!data.success) {
            showMessage(data.message, false);
        } else {
            showMessage(data.message || 'Success!', true);

            if (currentMode === 'login') {
                // Store session
                AppStorage.setItem('user_id', data.user_id);
                AppStorage.setItem('username', data.username);
                if (data.first_name) {
                    AppStorage.setItem('first_name', data.first_name);
                } else {
                    AppStorage.removeItem('first_name'); // Clear if none
                }
                AppStorage.setItem('role', data.role);
                
                // Redirect
                if (data.role === 'admin') {
                    window.location.href = 'admin.html';
                } else {
                    window.location.href = 'index.html';
                }
            } else {
                // Return to login mode after signup or reset
                setTimeout(() => {
                    currentMode = 'login';
                    updateUI();
                    passwordInput.value = '';
                    firstNameInput.value = '';
                    lastNameInput.value = '';
                    idNumberInput.value = '';
                }, 2000);
            }
        }
    } catch (err) {
        showMessage('Network error. Is the backend running?', false);
    } finally {
        submitBtn.disabled = false;
    }
});
