import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './styles.css';

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('OpenRepurpose root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
