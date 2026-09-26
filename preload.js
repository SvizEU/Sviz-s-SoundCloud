const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  playbackState: (isPlaying) => {
    ipcRenderer.send('playback-state', isPlaying);
  },
});

// ---------- ANTI-DETECTION PATCHES ----------
// These run before any page script so SoundCloud can't fingerprint Electron

Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  configurable: true,
});

Object.defineProperty(navigator, 'languages', {
  get: () => ['en-US', 'en'],
  configurable: true,
});

Object.defineProperty(navigator, 'vendor', {
  get: () => 'Google Inc.',
  configurable: true,
});

// Expose a chrome object like a real browser does
if (!window.chrome) {
  Object.defineProperty(window, 'chrome', {
    value: { app: {}, runtime: {} },
    writable: false,
    configurable: false,
  });
}

// ---------- MAIN ----------
window.addEventListener('DOMContentLoaded', () => {

  // ---------- UI CLEANUP ----------
  const style = document.createElement('style');
  style.textContent = `
    ::-webkit-scrollbar { width: 0px !important; background: transparent; }
    body { overflow-x: hidden !important; }
  `;
  document.head.appendChild(style);

  // ---------- MEDIA METADATA ----------
  // Reads the currently playing track from SoundCloud's DOM
  const updateMetadata = () => {
    if (!('mediaSession' in navigator)) return;

    const title =
      document.querySelector('.playbackSoundBadge__titleLink')?.title ||
      document.querySelector('.playbackSoundBadge__title')?.textContent?.trim() ||
      'SoundCloud';

    const artist =
      document.querySelector('.playbackSoundBadge__lightLink')?.textContent?.trim() || '';

    const artworkSrc =
      document.querySelector('.playbackSoundBadge__avatar img')?.src || '';

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: 'SoundCloud',
      artwork: artworkSrc
        ? [{ src: artworkSrc, sizes: '96x96', type: 'image/jpeg' }]
        : [],
    });
  };

  // ---------- MEDIA SESSION SETUP ----------
  const setupMediaSession = () => {
    if (!('mediaSession' in navigator)) return;

    updateMetadata();
    navigator.mediaSession.playbackState = 'paused';

    // Guard each handler so it only fires if the state actually needs to change,
    // preventing toggle misfires on a button that acts as play/pause toggle
    navigator.mediaSession.setActionHandler('play', () => {
      const ctrl = document.querySelector('.playControl');
      if (ctrl && navigator.mediaSession.playbackState !== 'playing') {
        ctrl.click();
        navigator.mediaSession.playbackState = 'playing';
      }
    });

    navigator.mediaSession.setActionHandler('pause', () => {
      const ctrl = document.querySelector('.playControl');
      if (ctrl && navigator.mediaSession.playbackState !== 'paused') {
        ctrl.click();
        navigator.mediaSession.playbackState = 'paused';
      }
    });

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      document.querySelector('.skipControl__next')?.click();
    });

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      document.querySelector('.skipControl__previous')?.click();
    });

    attachAudioListeners();
    observeTrackChanges();
  };

  // ---------- AUDIO STATE SYNC ----------
  // SoundCloud creates the <audio> element dynamically — poll until it exists
  let audioListenersAttached = false;

  const attachAudioListeners = () => {
    if (audioListenersAttached) return;

    const audioPoller = setInterval(() => {
      const audio = document.querySelector('audio');
      if (!audio) return;

      clearInterval(audioPoller);
      audioListenersAttached = true;

      audio.addEventListener('play', () => {
        if ('mediaSession' in navigator)
          navigator.mediaSession.playbackState = 'playing';
      });

      audio.addEventListener('pause', () => {
        if ('mediaSession' in navigator)
          navigator.mediaSession.playbackState = 'paused';
      });
    }, 500);
  };

  // ---------- TRACK CHANGE OBSERVER ----------
  // Watches the playback badge so metadata stays current as tracks change
  let trackObserver = null;

  const observeTrackChanges = () => {
    if (trackObserver) return;

    const badge = document.querySelector('.playbackSoundBadge');
    if (!badge) return;

    trackObserver = new MutationObserver(updateMetadata);
    trackObserver.observe(badge, { childList: true, subtree: true });
  };

  // ---------- WAIT FOR SOUNDCLOUD UI ----------
  // Gives up after 30s so the interval doesn't run forever on error
  const INIT_TIMEOUT = 30_000;
  const initStart = Date.now();

  const initInterval = setInterval(() => {
    if (document.querySelector('.playControl')) {
      clearInterval(initInterval);
      setupMediaSession();
      return;
    }
    if (Date.now() - initStart > INIT_TIMEOUT) {
      clearInterval(initInterval);
      console.warn('[preload] SoundCloud UI not found after 30s, giving up.');
    }
  }, 1000);

  // ---------- RE-ACTIVATE AFTER SPA NAVIGATION ----------
  // SoundCloud is a single-page app and can wipe media session handlers on navigation.
  // We detect this by probing the nexttrack handler — if it's gone, re-init.
  setInterval(() => {
    if (!('mediaSession' in navigator)) return;
    if (!document.querySelector('.playControl')) return;

    // Temporarily clear nexttrack to probe whether handlers are still registered.
    // If setActionHandler(null) succeeds without throwing, they were already gone.
    try {
      navigator.mediaSession.setActionHandler('nexttrack', null);
      // Handlers were wiped — re-initialize the full session
      setupMediaSession();
    } catch {
      // Handler still active — no action needed
    }
  }, 3000);

});