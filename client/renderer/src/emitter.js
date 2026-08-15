/** Emissor de eventos mínimo, no lugar de arrastar uma dependencia. */
export class Emitter {
  #listeners = new Map();

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    for (const handler of this.#listeners.get(event) ?? []) {
      try {
        handler(...args);
      } catch (error) {
        console.error(`[emitter] handler de "${event}" falhou:`, error);
      }
    }
  }

  removeAll() {
    this.#listeners.clear();
  }
}
