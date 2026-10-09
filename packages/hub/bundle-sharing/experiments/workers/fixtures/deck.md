---
title: Workers compile PoC
theme: default
layout: cover
author: Slidev Lab
---

# Workers compile PoC

Markdownから生成した資料

<!-- PRIVATE_PRESENTER_NOTE -->

---
layout: section
---

# Runtime reuse

同じテーマとVueを使う

---
layout: default
---

# Clicks and new CSS

<div v-click class="bg-fuchsia-600 text-white p-4 rounded" data-testid="click-one">First reveal</div>
<div v-click class="mt-4 text-teal-600" data-testid="click-two">Second reveal</div>

<div class="scoped-probe">Scoped style</div>

<style scoped>
.scoped-probe { border: 3px solid rgb(19, 105, 75); padding: 8px; }
</style>

---
layout: default
images:
  - src: ./diagram.svg
    label: R2 asset
---

# Revision image

![R2 asset](./diagram.svg)

---
layout: default
---

# Code and constants

```js
const revision = 'immutable'
```

<p :data-value="'constant-' + 7">Static expression</p>
