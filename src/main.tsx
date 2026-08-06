import React from 'react';
import { createRoot } from 'react-dom/client';
import { SplashScreen } from 'digital-boardgame-framework/client';
import { App } from './ui/App';
import './ui/styles.css';

// Startup interstitial. Self-managing (shows once per browser session) and
// renders its own fixed overlay above the app, hiding on Continue. The default
// middle is a live "other games" list pulled from the hub's games.json, so
// Impulse cross-promos the rest and stays current as games are added — the
// appId keeps Impulse itself out of its own list.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SplashScreen title="Impulse" appId="impulse" />
    <App />
  </React.StrictMode>,
);
