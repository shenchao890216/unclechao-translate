<script lang="ts" setup>
defineProps<{ modelValue: boolean; label: string }>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <label class="toggle-row">
    <span class="toggle-label">{{ label }}</span>
    <button
      type="button"
      role="switch"
      class="toggle"
      :class="{ on: modelValue }"
      :aria-checked="modelValue"
      @click="$emit('update:modelValue', !modelValue)"
    >
      <span class="knob" />
    </button>
  </label>
</template>

<style scoped>
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}
.toggle-label {
  font-size: 14px;
}
.toggle {
  position: relative;
  width: 40px;
  height: 22px;
  border: none;
  border-radius: 11px;
  background: #cbd5e1;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}
.toggle.on {
  background: #4f7cff;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
}
.toggle.on .knob {
  left: 20px;
}
</style>
