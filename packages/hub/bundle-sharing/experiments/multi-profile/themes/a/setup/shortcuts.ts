export default (nav, base) => [...base, { key: 'enter', fn: () => nav.next(), autoRepeat: false }];
