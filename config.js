// Centralized API Base URL configuration for local & cloud deployment
(function () {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname === '';
    
    // Set your production Render URL here once deployed, or let it fallback to localhost
    const PRODUCTION_API_URL = 'https://clinical-ai-ehr.onrender.com';
    
    window.API_BASE_URL = isLocal ? 'http://127.0.0.1:8000' : PRODUCTION_API_URL;
})();
