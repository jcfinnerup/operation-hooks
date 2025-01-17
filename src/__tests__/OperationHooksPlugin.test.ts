import { Plugin } from "graphile-build";
import { graphql, __InputValue } from "graphql";
import { EchoHiQuery, getSchema, makeHookPlugin } from "./common";

const UndoHooksPlugin: Plugin = builder => {
  builder.hook("GraphQLObjectType:fields:field", field => {
    if (field.resolve) {
      delete field.resolve["__asyncHooks"];
    }
    return field;
  });
};

test("checks all resolvers are wrapped", async () => {
  let err;
  try {
    await getSchema([UndoHooksPlugin]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(err).toMatchInlineSnapshot(
    `[Error: Schema validation error: operation hooks were not added to the following fields: Query.query, Query.id, Query.node, Query.echo, Mutation.echo]`
  );
});

test("calls hooks the correct number of times", async () => {
  let called = 0;
  const schema = await getSchema([
    makeHookPlugin(input => {
      called++;
      return input;
    }),
  ]);
  expect(called).toEqual(0);
  const data = await graphql(schema, EchoHiQuery);
  expect(called).toEqual(1);
  expect(data).toMatchInlineSnapshot(`
Object {
  "data": Object {
    "echo": "Hi",
  },
}
`);
});

test("throwing error in hook aborts resolve", async () => {
  const schema = await getSchema([
    makeHookPlugin(() => {
      throw new Error("Abort!");
    }),
  ]);
  const data = await graphql(schema, EchoHiQuery);
  expect(data.errors).toBeTruthy();
  expect(data.errors!.length).toEqual(1);
  expect(data).toMatchInlineSnapshot(`
Object {
  "data": Object {
    "echo": null,
  },
  "errors": Array [
    [GraphQLError: Abort!],
  ],
}
`);
});

test("allows exiting early without error", async () => {
  const schema = await getSchema([
    makeHookPlugin(input => {
      expect(typeof input).toEqual("symbol");
      return null;
    }),
  ]);
  const data = await graphql(schema, EchoHiQuery);
  expect(data.errors).toBeFalsy();
  expect(data).toMatchInlineSnapshot(`
Object {
  "data": Object {
    "echo": null,
  },
}
`);
});

test("allows replacing/augmenting output", async () => {
  const schema = await getSchema([
    makeHookPlugin(out => {
      return out + "(AFTER)";
    }, "after"),
  ]);
  const data = await graphql(schema, EchoHiQuery);
  expect(data.errors).toBeFalsy();
  expect(data).toMatchInlineSnapshot(`
Object {
  "data": Object {
    "echo": "Hi(AFTER)",
  },
}
`);
});

test("throws error if hook is registered after hooks have been called", async () => {
  const BadlyBehavedPlugin: Plugin = builder =>
    builder.hook("GraphQLObjectType:fields:field", (field, build) => {
      build.addOperationHook(() => ({}));
      return field;
    });
  let err;
  try {
    await getSchema([
      makeHookPlugin(out => {
        return out + "(AFTER)";
      }, "after"),
      BadlyBehavedPlugin,
    ]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(err).toMatchInlineSnapshot(
    `[Error: Attempted to register operation hook after a hook was applied; this indicates an issue with the ordering of your plugins. Ensure that the OperationHooksPlugin and anything that depends on it come at the end of the plugins list.]`
  );
});

test("throws error if hook returns undefined", async () => {
  const schema = await getSchema([
    makeHookPlugin(() => {
      return;
    }, "after"),
  ]);
  const result = await graphql(schema, EchoHiQuery);
  expect(result.errors).toBeTruthy();
  expect(result.errors).toMatchInlineSnapshot(`
Array [
  [GraphQLError: Logic error: operation hook returned 'undefined'.],
]
`);
});
