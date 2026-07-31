(function () {
  'use strict';

  const loadingEl = document.getElementById('loading');
  const loggedOutEl = document.getElementById('logged-out');
  const loggedInEl = document.getElementById('logged-in');
  const displayNameEl = document.getElementById('display-name');
  const voiceSelectEl = document.getElementById('voice-select');
  const formEl = document.getElementById('preferences-form');
  const statusEl = document.getElementById('save-status');
  const logoutButtonEl = document.getElementById('logout-button');
  const previewButtonEl = document.getElementById('preview-button');
  const previewStatusEl = document.getElementById('preview-status');

  const sliders = {
    volume: { input: document.getElementById('volume-range'), out: document.getElementById('volume-value') },
    pitch: { input: document.getElementById('pitch-range'), out: document.getElementById('pitch-value') },
    timbre: { input: document.getElementById('timbre-range'), out: document.getElementById('timbre-value') },
  };

  Object.keys(sliders).forEach(function (key) {
    const slider = sliders[key];
    slider.input.addEventListener('input', function () {
      slider.out.textContent = Number(slider.input.value).toFixed(2);
    });
  });

  function show(el) {
    el.hidden = false;
  }
  function hide(el) {
    el.hidden = true;
  }

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = kind || '';
  }

  function engineLabel(engine) {
    const labels = { browser: 'Navegador', edge: 'Edge TTS', piper: 'Piper', sapi: 'Windows (SAPI)', loquendo: 'Loquendo', melo: 'MeloTTS' };
    return labels[engine] || engine;
  }

  function populateVoices(voices, currentVoiceId) {
    voiceSelectEl.innerHTML = '';

    const byEngine = {};
    voices.forEach(function (voice) {
      byEngine[voice.engine] = byEngine[voice.engine] || [];
      byEngine[voice.engine].push(voice);
    });

    Object.keys(byEngine).forEach(function (engine) {
      const group = document.createElement('optgroup');
      group.label = engineLabel(engine);
      byEngine[engine].forEach(function (voice) {
        const option = document.createElement('option');
        option.value = voice.id;
        option.textContent = voice.label || voice.name;
        if (voice.id === currentVoiceId) {
          option.selected = true;
        }
        group.appendChild(option);
      });
      voiceSelectEl.appendChild(group);
    });
  }

  function loadPreferencesUi(me) {
    displayNameEl.textContent = me.user.displayName;

    Promise.all([
      fetch('/viewer/catalog').then(function (r) {
        return r.json();
      }),
      fetch('/viewer/preferences').then(function (r) {
        return r.json();
      }),
    ])
      .then(function (results) {
        const catalog = results[0];
        const prefs = results[1];

        populateVoices(catalog.voices || [], prefs.voiceId);
        sliders.volume.input.value = prefs.volume;
        sliders.pitch.input.value = prefs.pitch;
        sliders.timbre.input.value = prefs.timbre;
        Object.keys(sliders).forEach(function (key) {
          sliders[key].out.textContent = Number(sliders[key].input.value).toFixed(2);
        });

        hide(loadingEl);
        show(loggedInEl);
      })
      .catch(function () {
        setStatus('No se pudo cargar el catálogo de voces. Recargá la página.', 'error');
        hide(loadingEl);
        show(loggedInEl);
      });
  }

  function init() {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('viewer_auth_error');

    fetch('/viewer-auth/me')
      .then(function (r) {
        return r.json();
      })
      .then(function (me) {
        hide(loadingEl);
        if (me.authenticated) {
          show(loggedInEl);
          loadPreferencesUi(me);
        } else {
          show(loggedOutEl);
          if (authError) {
            const messages = {
              denied: 'Cancelaste el inicio de sesión en Twitch.',
              state: 'La sesión de login expiró, probá de nuevo.',
              missing_code: 'Twitch no mandó el código esperado, probá de nuevo.',
              exchange: 'No se pudo confirmar tu identidad con Twitch, probá de nuevo.',
            };
            const p = document.createElement('p');
            p.textContent = messages[authError] || 'Algo falló iniciando sesión, probá de nuevo.';
            p.className = 'error';
            loggedOutEl.appendChild(p);
          }
        }
      })
      .catch(function () {
        hide(loadingEl);
        setStatus('No se pudo contactar el servidor. Recargá la página.', 'error');
        show(loggedOutEl);
      });
  }

  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    setStatus('Guardando…', '');

    const body = {
      voiceId: voiceSelectEl.value || null,
      volume: Number(sliders.volume.input.value),
      pitch: Number(sliders.pitch.input.value),
      timbre: Number(sliders.timbre.input.value),
    };

    fetch('/viewer/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (result.ok) {
          setStatus('Guardado.', 'ok');
        } else {
          setStatus(result.data.error || 'No se pudo guardar.', 'error');
        }
      })
      .catch(function () {
        setStatus('No se pudo contactar el servidor.', 'error');
      });
  });

  function setPreviewStatus(message) {
    previewStatusEl.textContent = message;
  }

  // `browser:*` lo sintetiza el propio navegador del viewer (Web Speech), nunca
  // el servidor: no hay nada que generar del lado del backend para esa voz.
  function previewWithBrowserVoice(name, pitch, volume) {
    if (!('speechSynthesis' in window)) {
      setPreviewStatus('Tu navegador no soporta síntesis de voz.');
      return;
    }
    const utterance = new SpeechSynthesisUtterance('Así va a sonar tu voz en el chat, pe tontito.');
    const match = window.speechSynthesis.getVoices().find(function (voice) {
      return voice.name === name;
    });
    if (match) {
      utterance.voice = match;
      utterance.lang = match.lang;
    }
    utterance.pitch = pitch;
    utterance.volume = volume;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setPreviewStatus(match ? '' : 'No se encontró esa voz en tu navegador; sonó con la voz por default.');
  }

  previewButtonEl.addEventListener('click', function () {
    const voiceId = voiceSelectEl.value;
    if (!voiceId) {
      setPreviewStatus('Elegí una voz primero.');
      return;
    }

    const separator = voiceId.indexOf(':');
    const engine = separator === -1 ? '' : voiceId.slice(0, separator);
    const name = separator === -1 ? '' : voiceId.slice(separator + 1);
    const pitch = Number(sliders.pitch.input.value);
    const timbre = Number(sliders.timbre.input.value);
    const volume = Number(sliders.volume.input.value);

    if (engine === 'browser') {
      previewWithBrowserVoice(name, pitch, volume);
      return;
    }

    previewButtonEl.disabled = true;
    setPreviewStatus('Generando…');

    fetch('/viewer/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voiceId: voiceId, pitch: pitch, timbre: timbre }),
    })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (data) {
            throw new Error(data.error || 'No se pudo generar la muestra.');
          });
        }
        return r.blob();
      })
      .then(function (blob) {
        const audio = new Audio(URL.createObjectURL(blob));
        audio.volume = volume;
        setPreviewStatus('');
        return audio.play();
      })
      .catch(function (error) {
        setPreviewStatus(error.message || 'No se pudo reproducir la muestra.');
      })
      .finally(function () {
        previewButtonEl.disabled = false;
      });
  });

  logoutButtonEl.addEventListener('click', function () {
    fetch('/viewer-auth/logout', { method: 'POST' }).finally(function () {
      window.location.reload();
    });
  });

  init();
})();
