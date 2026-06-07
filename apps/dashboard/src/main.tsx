import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { GlassesApp } from './GlassesApp';

function isGlassesRoute(): boolean {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const search = new URLSearchParams(window.location.search);
  return pathname === '/glasses' || search.get('display') === 'rayban';
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Dashboard root element was not found');
}

createRoot(root).render(
  <StrictMode>{isGlassesRoute() ? <GlassesApp /> : <App />}</StrictMode>,
);
