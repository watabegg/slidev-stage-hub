import { mountHub } from '@slidock/slidock/frontend';
import '@slidock/slidock/frontend/style.css';
import './theme.css';

await mountHub('#app', {
  navigation: { homeHref: '/', homeLabel: 'MY SLIDES' },
  home: {
    title: 'MY SLIDES',
    hero: true,
    description: 'チーム内の発表資料',
    logo: false,
    links: [{ label: 'GitHub', href: 'https://github.com/example/slides' }],
    footer: 'Example team',
    categoryLabels: { category: '登壇' },
  },
});
