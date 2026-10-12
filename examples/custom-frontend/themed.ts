import { mountHub } from '@slidock/slidock/frontend';
import '@slidock/slidock/frontend/style.css';
import './theme.css';

await mountHub('#app', {
  navigation: { homeHref: '/', homeLabel: 'MY SLIDES' },
});
