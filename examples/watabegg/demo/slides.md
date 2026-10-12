---
theme: slidev-theme-watabegg
title: watabegg 1.2.1 example
subtitle: Published theme, independent workspace
author: Slidev Slive / Slidock
themeConfig:
  watabegg:
    color: blue
transition: fade
---

---
layout: two-cols
title: Theme components
---

<script setup>
import diagram from './assets/diagram.svg'
</script>

::left::

<FigureGrid
  :images="[{ src: diagram, alt: 'Local example asset' }]"
  caption="FigureGrid example"
/>

::right::

<QuestionList :items="[{ text: 'Published theme', items: ['Version 1.2.1', 'No local checkout required'] }]" />

<div v-click>First click step</div>
<div v-click>Second click step</div>

<!-- PRIVATE_NOTE_watabegg: This note must not be present in public output. -->

---
layout: section
title: Ready to present
sectionNumber: 1
---

Theme-specific layouts and components are supplied by the installed package.

<!-- PRIVATE_NOTE_watabegg: Close the demo here. -->
