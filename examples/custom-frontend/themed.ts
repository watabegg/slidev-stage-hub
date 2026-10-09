import { mountHub } from '@slidev-stage-hub/hub/frontend';
import '@slidev-stage-hub/hub/frontend/style.css';
import './theme.css';

await mountHub('#app', {
  navigation: { homeHref: '/', homeLabel: 'MY SLIDES' },
});
