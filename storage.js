// storage.js - Robust storage helper wrapper with window.name fallback for file:// sandboxing
(function() {
    window.AppStorage = {
        getItem: function(key) {
            try {
                // If localStorage is accessible, use it
                return localStorage.getItem(key);
            } catch (e) {
                // Fallback to reading from window.name JSON string
                try {
                    const session = JSON.parse(window.name || '{}');
                    return session[key] !== undefined ? session[key] : null;
                } catch (err) {
                    return null;
                }
            }
        },
        setItem: function(key, value) {
            try {
                localStorage.setItem(key, value);
            } catch (e) {
                try {
                    const session = JSON.parse(window.name || '{}');
                    session[key] = String(value);
                    window.name = JSON.stringify(session);
                } catch (err) {
                    console.error("AppStorage fallback setItem error:", err);
                }
            }
        },
        removeItem: function(key) {
            try {
                localStorage.removeItem(key);
            } catch (e) {
                try {
                    const session = JSON.parse(window.name || '{}');
                    delete session[key];
                    window.name = JSON.stringify(session);
                } catch (err) {
                    console.error("AppStorage fallback removeItem error:", err);
                }
            }
        },
        clear: function() {
            try {
                localStorage.clear();
            } catch (e) {
                window.name = '{}';
            }
        }
    };
})();
