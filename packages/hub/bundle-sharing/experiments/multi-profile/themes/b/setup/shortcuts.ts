export default (nav, base) => [...base, { key: 'enter', fn: () => nav.prev(), autoRepeat: false }];
