type AnyObject = Record<PropertyKey, unknown>;

type Builtin =
  | Date
  | RegExp
  | Map<unknown, unknown>
  | Set<unknown>
  | WeakMap<object, unknown>
  | WeakSet<object>
  | Promise<unknown>
  | Error;

type DeepMerge<T, U> = T extends Builtin
  ? U
  : U extends Builtin
  ? U
  : T extends readonly unknown[]
  ? U
  : U extends readonly unknown[]
  ? U
  : T extends object
  ? U extends object
    ? {
        [K in keyof T | keyof U]: K extends keyof U
          ? K extends keyof T
            ? DeepMerge<T[K], U[K]>
            : U[K]
          : K extends keyof T
          ? T[K]
          : never;
      }
    : U
  : U;

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isBlockedKey(key: PropertyKey): boolean {
  return typeof key === "string" && BLOCKED_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function deepMergeTwo<T, U>(target: T, source: U): DeepMerge<T, U> {
  // Non-objects and special objects are replaced.
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return source as DeepMerge<T, U>;
  }

  const result: Record<PropertyKey, unknown> = Object.create(
    Object.getPrototypeOf(target)
  );

  // Copy target.
  for (const key of Reflect.ownKeys(target)) {
    if (isBlockedKey(key)) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(target, key);

    if (descriptor) {
      Object.defineProperty(result, key, descriptor);
    }
  }

  // Merge source.
  for (const key of Reflect.ownKeys(source)) {
    if (isBlockedKey(key)) {
      continue;
    }

    const sourceDescriptor = Object.getOwnPropertyDescriptor(source, key);

    if (!sourceDescriptor) {
      continue;
    }

    const sourceValue = sourceDescriptor.value;

    const targetDescriptor = Object.getOwnPropertyDescriptor(target, key);

    const targetValue = targetDescriptor?.value;

    if (
      targetDescriptor &&
      "value" in targetDescriptor &&
      isPlainObject(targetValue) &&
      isPlainObject(sourceValue)
    ) {
      Object.defineProperty(result, key, {
        ...sourceDescriptor,
        value: deepMergeTwo(targetValue, sourceValue),
      });
    } else {
      Object.defineProperty(result, key, sourceDescriptor);
    }
  }

  return result as DeepMerge<T, U>;
}

export function deepMerge<T extends object>(target: T): T;

export function deepMerge<T extends object, U extends object>(
  target: T,
  source: U
): DeepMerge<T, U>;

export function deepMerge<T extends object, U extends object, V extends object>(
  target: T,
  source: U,
  source2: V
): DeepMerge<DeepMerge<T, U>, V>;

export function deepMerge<
  T extends object,
  U extends object,
  V extends object,
  W extends object
>(
  target: T,
  source: U,
  source2: V,
  source3: W
): DeepMerge<DeepMerge<DeepMerge<T, U>, V>, W>;

export function deepMerge(target: object, ...sources: object[]): object {
  let result = target;

  for (const source of sources) {
    result = deepMergeTwo(result, source);
  }

  return result;
}
