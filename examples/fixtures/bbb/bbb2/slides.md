---
theme: default
title: BBB 2 — bundle baseline
subtitle: Independent Slidev fixture
author: Slidev Lab
date: '2026/10/08'
transition: fade
---

# BBB2 — bundle baseline

Independent Slidev fixture

---
layout: two-cols
title: Same paths, independent content
---

### Relative image

![Conflict fixture image](./assets/conflict.svg)

<div class="fixture-conflict">bbb2 scoped style</div>

::right::
### Deck content

- Deck bbb2
- Same relative image path, different file bytes
- First reveal and second reveal

<div v-click>First click step</div>
<div v-click>Second click step</div>

<style scoped>
.fixture-conflict {
  --fixture-conflict-color: #7e22ce;
  padding: 0.65rem 0.9rem;
  border-left: 0.35rem solid var(--fixture-conflict-color);
  color: white;
  background: #7e22ce;
}
</style>

<!--
PRIVATE_NOTE_bbb2: Keep this note in the private fixture source only.
-->

---
layout: default
title: Code, math, and diagram
---

# Code, math, and diagram

$$
E_{bbb2} = mc^2
$$

```ts {1-3}
const deck = 'bbb2'
const runtime = 'Slidev 53.0.0'
console.log(`${deck}: ${runtime}`)
```

```mermaid
flowchart LR
  source["bbb2 source"] --> build["Slidev build"] --> output["/bbb2/"]
```

<!--
PRIVATE_NOTE_bbb2: Verify equation and highlighted code on page 3.
-->
