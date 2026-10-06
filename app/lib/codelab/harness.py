# app/lib/codelab/harness.py
# Code Lab test harness. Reads {"code", "functionName", "testCases", "adapters"} as JSON on stdin and
# prints {"results": [...]} (or {"error", ...} when the code cannot load) as JSON on stdout.
#
# Test shapes:
#   function: {"input": {param: value}, "expected": value}, or {"args": [positional...], "expected": value}
#   class:    {"input": {ctor_kw: value, "operations": [["method", *args], ...]}, "expected": [one per operation]}
#             ("init": [positional ctor args] may replace the ctor keywords; workbook questions use it)
#   expected errors: {"raises": "ValueError"} as the expected value, or as one entry of a class test's list.
# adapters (optional): {"args": {param: "tree" | "list" | "graph"}, "returns": "tree" | "list" | "graph"}
#   turn level-order arrays / arrays / 1-indexed adjacency lists into TreeNode / ListNode / Node objects
#   before the call, and the returned object back into the same JSON shape after it.
import inspect, json, math, sys, traceback

payload = json.load(sys.stdin)
source = payload.get("code") or ""
function_name = payload.get("functionName")
tests = payload.get("testCases") or []
adapters = payload.get("adapters") or {}


def format_error(exc=None):
    if isinstance(exc, SyntaxError):
        loc = f"line {exc.lineno}" if exc.lineno else "unknown line"
        if exc.offset:
            loc += f", col {exc.offset}"
        msg = f"SyntaxError: {exc.msg} ({loc})"
        if exc.text:
            msg += "\n  " + exc.text.rstrip()
            if exc.offset:
                msg += "\n  " + (" " * max(exc.offset - 1, 0)) + "^"
        return msg
    lines = traceback.format_exc().strip().split("\n")
    return lines[-1] if lines else "Execution failed"


namespace = {}
try:
    exec(compile(source, "<user_code>", "exec"), namespace)
except Exception as exc:
    print(json.dumps({"error": format_error(exc), "errorSource": "user_code",
                      "errorTitle": "Your code could not be loaded", "results": []}))
    sys.exit(0)

fn = namespace.get(function_name)
if not callable(fn):
    print(json.dumps({"error": f"Function '{function_name}' is not defined", "errorSource": "user_code",
                      "errorTitle": "Your code is missing the required function", "results": []}))
    sys.exit(0)


# --- node adapters -------------------------------------------------------------------------------
class _TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right


class _ListNode:
    def __init__(self, val=0, next=None):
        self.val, self.next = val, next


class _Node:
    def __init__(self, val=0, neighbors=None):
        self.val = val
        self.neighbors = neighbors if neighbors is not None else []


def user_class(name, fallback):
    # Use the class the starter (or the user) defined so isinstance checks and helpers line up.
    c = namespace.get(name)
    return c if isinstance(c, type) else fallback


def build_tree(arr):
    TreeNode = user_class("TreeNode", _TreeNode)
    if not arr or arr[0] is None:
        return None
    root = TreeNode(arr[0])
    queue, i = [root], 1
    while queue and i < len(arr):
        node = queue.pop(0)
        if i < len(arr) and arr[i] is not None:
            node.left = TreeNode(arr[i]); queue.append(node.left)
        i += 1
        if i < len(arr) and arr[i] is not None:
            node.right = TreeNode(arr[i]); queue.append(node.right)
        i += 1
    return root


def tree_to_array(root):
    if root is None:
        return []
    out, queue, seen = [], [root], 0
    while queue:
        node = queue.pop(0)
        seen += 1
        if seen > 100000:
            raise ValueError("returned tree is too large or has a cycle")
        if node is None:
            out.append(None)
        else:
            out.append(node.val)
            queue.append(node.left)
            queue.append(node.right)
    while out and out[-1] is None:
        out.pop()
    return out


def build_list(arr):
    ListNode = user_class("ListNode", _ListNode)
    head = None
    for v in reversed(arr or []):
        head = ListNode(v, head)
    return head


def list_to_array(head):
    out = []
    while head is not None:
        out.append(head.val)
        if len(out) > 100000:
            raise ValueError("returned linked list is too long or has a cycle")
        head = head.next
    return out


def build_graph(adj):
    Node = user_class("Node", _Node)
    if not adj:
        return None
    nodes = [Node(i + 1) for i in range(len(adj))]
    for i, nbrs in enumerate(adj):
        nodes[i].neighbors = [nodes[j - 1] for j in nbrs]
    return nodes[0]


def graph_to_adj(node):
    if node is None:
        return []
    seen, queue = {node.val: node}, [node]
    while queue:
        n = queue.pop(0)
        for nb in n.neighbors:
            if nb.val not in seen:
                seen[nb.val] = nb
                queue.append(nb)
    return [sorted(nb.val for nb in seen[v].neighbors) for v in sorted(seen)]


TO_NODES = {"tree": build_tree, "list": build_list, "graph": build_graph}
TO_JSON = {"tree": tree_to_array, "list": list_to_array, "graph": graph_to_adj}


# --- comparison ----------------------------------------------------------------------------------
def normalize(x):
    # JSON has no tuples, sets or non-string keys, so compare in JSON's terms.
    if isinstance(x, (list, tuple)):
        return [normalize(v) for v in x]
    if isinstance(x, (set, frozenset)):
        items = [normalize(v) for v in x]
        try:
            return sorted(items)
        except TypeError:
            return items
    if isinstance(x, dict):
        return {k if isinstance(k, str) else str(k) if isinstance(k, (int, float)) else repr(k): normalize(v)
                for k, v in x.items()}
    return x


def same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b if isinstance(a, bool) and isinstance(b, bool) else False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if isinstance(a, float) or isinstance(b, float):
            return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6)
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    return a == b


def is_raises(v):
    return isinstance(v, dict) and set(v) == {"raises"} and isinstance(v["raises"], str)


def raised_matches(exc, spec):
    return spec["raises"] in [c.__name__ for c in type(exc).__mro__]


def show(v):
    try:
        return json.dumps(v)
    except (TypeError, ValueError):
        return repr(v)


# --- running -------------------------------------------------------------------------------------
def call_function(test):
    if isinstance(test.get("args"), list):
        result = fn(*test["args"])
        kind = adapters.get("returns")
        return TO_JSON[kind](result) if kind else result
    kwargs = dict(test.get("input", {}))
    for name, kind in (adapters.get("args") or {}).items():
        if name in kwargs:
            kwargs[name] = TO_NODES[kind](kwargs[name])
    result = fn(**kwargs)
    kind = adapters.get("returns")
    return TO_JSON[kind](result) if kind else result


def run_operations(test):
    input_data = test.get("input", {})
    expected = test.get("expected")
    expected = expected if isinstance(expected, list) else []
    if isinstance(input_data.get("init"), list):
        instance = fn(*input_data["init"])
    else:
        instance = fn(**{k: v for k, v in input_data.items() if k != "operations"})
    outputs = []
    for i, operation in enumerate(input_data.get("operations") or []):
        if not operation:
            raise ValueError("Operation entries must not be empty")
        want = expected[i] if i < len(expected) else None
        try:
            out = getattr(instance, operation[0])(*operation[1:])
        except Exception as exc:
            if is_raises(want) and raised_matches(exc, want):
                outputs.append(want)
                continue
            raise RuntimeError(f"operation {i + 1} ({operation[0]}) raised {type(exc).__name__}: {exc}") from exc
        outputs.append({"returned": normalize(out)} if is_raises(want) else out)
    return outputs


def run_test(test):
    input_data = test.get("input", {})
    if inspect.isclass(fn) and isinstance(input_data.get("operations"), list):
        return run_operations(test)
    if is_raises(test.get("expected")):
        try:
            result = call_function(test)
        except Exception as exc:
            if raised_matches(exc, test["expected"]):
                return test["expected"]
            raise
        return {"returned": normalize(result)}
    return call_function(test)


results = []
for i, test in enumerate(tests):
    try:
        result = normalize(run_test(test))
        expected = test.get("expected")
        passed = same(result, expected)
        positional = inspect.isclass(fn) and isinstance(test.get("input", {}).get("operations"), list)
        if not passed and not positional and isinstance(result, list) and isinstance(expected, list):
            # Many problems accept any order; compare as sorted lists when both sort.
            try:
                passed = same(sorted(result, key=json.dumps), sorted(expected, key=json.dumps))
            except TypeError:
                pass
        results.append({"index": i, "passed": passed, "actual": show(result), "expected": show(expected)})
    except Exception as exc:
        results.append({"index": i, "passed": False, "error": format_error(exc), "errorSource": "user_code"})
print(json.dumps({"results": results}))
