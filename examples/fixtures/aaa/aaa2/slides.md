---
theme: default
title: AAA 2 — bundle baseline
subtitle: Independent Slidev fixture
author: Slidev Lab
date: '2026/10/08'
transition: fade
---

# AAA2 — bundle baseline

Independent Slidev fixture

---
layout: two-cols
title: Same paths, independent content
---

### Relative image

![Conflict fixture image](./assets/conflict.svg)

<div class="fixture-conflict">aaa2 scoped style</div>

::right::
### Deck content

- Deck aaa2
- Same relative image path, different file bytes
- First reveal and second reveal

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
layout: default
title: Code, math, and diagram
---

# Code, math, and diagram

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
