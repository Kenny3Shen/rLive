type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 每次调用独立存储，测试之间不共享记忆。 */
export function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

export function throwingStorage(): StorageLike {
  const fail = () => {
    throw new Error("storage disabled");
  };
  return { getItem: fail, setItem: fail };
}
