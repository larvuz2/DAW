import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { useStore } from './state/store.js';
import { sync } from './state/sync.js';
import { getEngine } from './audio/index.js';
import { renderProject } from './audio/render.js';
import { injectMidi } from './lib/midiInput.js';
import './styles.css';

useStore.getState().initAuth();

// Handy for debugging and scripting from the browser console:
//   greanteadawy.store.getState().project, greanteadawy.engine(), greanteadawy.midi([0x90, 60, 100])
window.greanteadawy = { store: useStore, engine: getEngine, sync, render: renderProject, midi: injectMidi };

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
