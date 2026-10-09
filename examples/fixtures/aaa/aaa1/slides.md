---
theme: default
title: AAA 1 — bundle baseline
subtitle: Independent Slidev fixture
author: Slidev Lab
date: '2026/10/08'
transition: fade
---

# AAA1 — bundle baseline

Independent Slidev fixture

---
layout: two-cols
title: Same paths, independent content
---

### Relative image

![Conflict fixture image](./assets/conflict.svg)

<div class="fixture-conflict">aaa1 scoped style</div>

::right::
### Deck content

- Deck aaa1
- Same relative image path, different file bytes
- First reveal and second reveal

<div v-click>First click step</div>
<div v-click>Second click step</div>

<style scoped>
.fixture-conflict {
  --fixture-conflict-color: #2563eb;
  padding: 0.65rem 0.9rem;
  border-left: 0.35rem solid var(--fixture-conflict-color);
  color: white;
  background: #2563eb;
}
</style>

<!--
PRIVATE_NOTE_aaa1: Keep this note in the private fixture source only.
-->

---
layout: default
title: Code, math, and diagram
---

# Code, math, and diagram

$$
E_{aaa1} = mc^2
$$

```ts {1-3}
const deck = 'aaa1'
const runtime = 'Slidev 53.0.0'
console.log(`${deck}: ${runtime}`)
```

```mermaid
flowchart LR
  source["aaa1 source"] --> build["Slidev build"] --> output["/aaa1/"]
```

<!--
PRIVATE_NOTE_aaa1: Verify equation and highlighted code on page 3.
-->
