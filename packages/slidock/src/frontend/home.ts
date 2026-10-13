import './style.css';
import { createApp } from 'vue';
import DefaultHome from './DefaultHome.vue';
import { showStartupError } from './startup-error.js';

const root =
  document.querySelector('#app') ?? document.body.appendChild(document.createElement('main'));
try {
  createApp(DefaultHome).mount(root);
} catch (error) {
  showStartupError(error);
}
