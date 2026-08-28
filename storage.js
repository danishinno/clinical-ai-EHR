// storage.js - Robust session-based storage helper wrapper with window.name fallback for sandboxing
(function() {
    // One-time cleanup of any legacy permanent localStorage tokens from previous versions
    try {
        if (typeof localStorage !== 'undefined') {
            ['user_id', 'username', 'first_name', 'last_name', 'role'].forEach(function(k) {
                localStorage.removeItem(k);
            });
        }
    } catch (e) {
        // Ignore cross-origin / sandboxing restrictions
    }

    window.AppStorage = {
        getItem: function(key) {
            try {
                // If sessionStorage is accessible, use it
                return sessionStorage.getItem(key);
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
                sessionStorage.setItem(key, value);
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
                sessionStorage.removeItem(key);
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
                sessionStorage.clear();
                if (typeof localStorage !== 'undefined') {
                    localStorage.clear();
                }
            } catch (e) {
                window.name = '{}';
            }
        }
    };
})();
