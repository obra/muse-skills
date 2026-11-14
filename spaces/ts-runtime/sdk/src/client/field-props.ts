// Form-input attributes read from the same Zod request schema the server
// enforces, so the page and the server can't disagree about a field's limits.

/** Attributes to spread onto the `<input>` or `<textarea>` that feeds one request field. */
export type FieldProps = {
  name: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number | "any";
  type?: "email" | "url" | "number";
};

/**
 * One request schema's fields: an object field nests its own fields, a list
 * field takes the fields of one item, and every other field is the
 * attributes of its input.
 */
export type RequestFields<S> = S extends { shape: infer Shape }
  ? { readonly [F in keyof Shape]: RequestFields<Shape[F]> }
  : S extends { element: infer Item }
    ? RequestFields<Item>
    : S extends { unwrap(): infer Inner }
      ? RequestFields<Inner>
      : FieldProps;

type SchemaNode = {
  _zod: {
    def: {
      type: string;
      innerType?: SchemaNode;
      element?: SchemaNode;
      shape?: Record<string, SchemaNode>;
    };
    bag: {
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      exclusiveMaximum?: number;
      format?: string;
    };
  };
};

type Described = FieldProps | { [field: string]: Described };

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch"]);
const INTEGER_FORMATS = new Set(["safeint", "int32", "uint32", "int64", "uint64"]);

/** The fields of a request schema, or `{}` when the request is not an object. */
export function describeRequest(schema: unknown): Record<string, Described> {
  const node = schema as SchemaNode | undefined;
  if (node?._zod?.def.type !== "object") {
    return {};
  }
  return describe(node, "", new Set()) as Record<string, Described>;
}

// `active` holds the object schemas on the current path, so a self-referencing
// schema (a category with child categories) stops at its first repeat.
// A field inside an optional section (`.optional()`, `.nullable()`, `.default()`) or a list
// item is never `required`: the server accepts the section left empty, and the box that adds a
// list item is empty again once the item is added.
function describe(start: SchemaNode, name: string, active: Set<SchemaNode>, parentOptional = false): Described {
  let node = start;
  let optional = parentOptional;
  while (WRAPPERS.has(node._zod.def.type) && node._zod.def.innerType !== undefined) {
    if (node._zod.def.type !== "readonly" && node._zod.def.type !== "catch") {
      optional = true;
    }
    node = node._zod.def.innerType;
  }
  const def = node._zod.def;
  if (def.type === "object" && def.shape !== undefined) {
    if (active.has(node)) return {};
    active.add(node);
    const fields: { [field: string]: Described } = {};
    for (const [field, child] of Object.entries(def.shape)) {
      fields[field] = describe(child, field, active, optional);
    }
    active.delete(node);
    return fields;
  }
  if (def.type === "array" && def.element !== undefined) {
    return describe(def.element, name, active, true);
  }
  return scalar(node, name, optional);
}

function scalar(node: SchemaNode, name: string, optional: boolean): FieldProps {
  const props: FieldProps = { name };
  const bag = node._zod.bag;
  if (node._zod.def.type === "string") {
    if (bag.minimum !== undefined && bag.minimum > 0) {
      props.minLength = bag.minimum;
      if (!optional) props.required = true;
    }
    if (bag.maximum !== undefined) props.maxLength = bag.maximum;
    if (bag.format === "email" || bag.format === "url") {
      props.type = bag.format;
      if (!optional) props.required = true;
    }
    return props;
  }
  if (node._zod.def.type === "number") {
    // An exclusive bound on an integer becomes the next allowed whole number;
    // on a decimal it stays the bound itself (HTML has no exclusive bound), and
    // the server still rejects the bound with a readable `SpaceActionError`.
    const integer = bag.format !== undefined && INTEGER_FORMATS.has(bag.format);
    const step = integer ? 1 : 0;
    props.type = "number";
    props.step = integer ? 1 : "any";
    if (!optional) props.required = true;
    const min = tightest(Math.max, bag.minimum, bag.exclusiveMinimum, step);
    const max = tightest(Math.min, bag.maximum, bag.exclusiveMaximum, -step);
    if (min !== undefined) props.min = min;
    if (max !== undefined) props.max = max;
  }
  return props;
}

// `.int()` adds the safe-integer range as its own bound; it is not a limit a
// person could reach by typing, so it never becomes an attribute.
function tightest(
  pick: (a: number, b: number) => number,
  inclusive: number | undefined,
  exclusive: number | undefined,
  integerStep: number,
): number | undefined {
  const bounds = [inclusive, exclusive === undefined ? undefined : exclusive + integerStep].filter(
    (bound): bound is number =>
      bound !== undefined && Number.isFinite(bound) && Math.abs(bound) < Number.MAX_SAFE_INTEGER,
  );
  return bounds.length === 0 ? undefined : bounds.reduce(pick);
}
