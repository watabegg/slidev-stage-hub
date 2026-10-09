---
theme: slidev-theme-watabegg
title: AAA 2 — bundle baseline
subtitle: Independent Slidev fixture
author: Slidev Lab
date: '2026/10/08'
themeConfig:
  watabegg:
    color: green
    footer:
      text: baseline aaa2
transition: fade
---

---
layout: two-cols
title: Same paths, independent content
---

::left::
### Relative image

![Conflict fixture image](./assets/conflict.svg)

<div class="fixture-conflict">aaa2 scoped style</div>

::right::
### Theme component

<QuestionList
  :items="[
    { text: 'Deck aaa2', items: ['Same relative image path', 'Different file bytes'] },
    { text: 'Click state', items: ['First reveal', 'Second reveal'] }
  ]"
/>

<div v-click>First click step</div>
<div v-click>Second click step</div>

<style scoped>
.fixture-conflict {
  --fixture-conflict-color: #15803d;
  padding: 0.65rem 0.9rem;
  border-left: 0.35rem solid var(--fixture-conflict-color);
  color: white;
  background: #15803d;
}
</style>

<!--
PRIVATE_NOTE_aaa2: Keep this note in the private fixture source only.
-->

---
layout: section
title: Theme setup, code, and math
sectionNumber: 1
---

The theme setup enables Mermaid and code highlighting.

$$
E_{aaa2} = mc^2
$$

```ts {1-3}
const deck = 'aaa2'
const runtime = 'Slidev 53.0.0'
console.log(`${deck}: ${runtime}`)
```

```mermaid
flowchart LR
  source["aaa2 source"] --> build["Slidev build"] --> output["/aaa2/"]
```

<!--
PRIVATE_NOTE_aaa2: Verify equation and highlighted code on page 3.
-->
