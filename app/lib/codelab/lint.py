# app/lib/codelab/lint.py
# Structural checks that a Code Lab problem's starter code matches its tests, without running anything.
# stdin: JSON list of problems. stdout: JSON list of {"id", "issues": [str]} (empty issues = clean).
import ast, json, sys

BUILDERS = ("_build_tree", "_build_list", "_build_graph")
ADAPTER_KINDS = ("tree", "list", "graph")


def params(fn):
    a = fn.args
    names = [x.arg for x in a.posonlyargs + a.args + a.kwonlyargs]
    pos = a.posonlyargs + a.args
    optional = [x.arg for x in pos[len(pos) - len(a.defaults):]] if a.defaults else []
    optional += [k.arg for k, d in zip(a.kwonlyargs, a.kw_defaults) if d is not None]
    return names, optional, bool(a.kwarg), bool(a.vararg)


def lint(p):
    issues = []
    fn_name = p.get("functionName")
    tests = p.get("testCases") or []
    adapters = p.get("adapters") or {}
    if not isinstance(fn_name, str) or not fn_name:
        return ["functionName is missing"]
    try:
        tree = ast.parse(p.get("starterCode") or "")
    except SyntaxError as e:
        return [f"starter code does not parse: {e.msg} (line {e.lineno})"]
    top = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    node = top.get(fn_name)
    if node is None:
        return [f"starter code does not define {fn_name} at the top level"]
    if not tests:
        issues.append("has no test cases")
    for i, t in enumerate(tests):
        if isinstance(t, dict) and isinstance(t.get("args"), list) and "expected" in t:
            continue
        if not isinstance(t, dict) or not isinstance(t.get("input"), dict) or "expected" not in t:
            issues.append(f"test {i} needs an input object and an expected value")
            return issues

    if isinstance(node, ast.FunctionDef):
        names, optional, has_kwargs, _ = params(node)
        # Converting test data inside the user's function breaks recursion; declare adapters instead.
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name) and sub.func.id in BUILDERS:
                issues.append(f"{fn_name} calls {sub.func.id}() itself; declare adapters so Code Lab converts test data at the boundary")
                break
        for name, kind in (adapters.get("args") or {}).items():
            if name not in names:
                issues.append(f"adapters.args.{name} is not a parameter of {fn_name}")
            if kind not in ADAPTER_KINDS:
                issues.append(f"adapters.args.{name} must be one of {', '.join(ADAPTER_KINDS)}")
        if adapters.get("returns") not in (None,) + ADAPTER_KINDS:
            issues.append(f"adapters.returns must be one of {', '.join(ADAPTER_KINDS)}")
        for i, t in enumerate(tests):
            if isinstance(t.get("args"), list):
                if not (len(names) - len(optional) <= len(t["args"]) <= len(names)) and not params(node)[3]:
                    issues.append(f"test {i} passes {len(t['args'])} argument(s); {fn_name} takes ({', '.join(names)})")
                    break
                continue
            keys = set(t["input"])
            missing = [n for n in names if n not in keys and n not in optional]
            extra = [] if has_kwargs else sorted(k for k in keys if k not in names)
            if missing or extra:
                issues.append(f"test {i} input keys {sorted(keys)} do not match {fn_name}({', '.join(names)})")
                break
        return issues

    if adapters:
        issues.append("adapters apply to function problems only")
    methods = {n.name: n for n in node.body if isinstance(n, ast.FunctionDef)}
    init = methods.get("__init__")
    init_names, init_optional = (params(init)[0][1:], params(init)[1]) if init else ([], [])
    for i, t in enumerate(tests):
        inp = t["input"]
        ops = inp.get("operations")
        if not isinstance(ops, list):
            issues.append(f"test {i}: a class problem needs input.operations as a list of [method, *args]")
            break
        ctor = set(inp) - {"operations", "init"}
        if isinstance(inp.get("init"), list):
            n = len(inp["init"])
            if not (len(init_names) - len(init_optional) <= n <= len(init_names)):
                issues.append(f"test {i} constructs with {n} argument(s); __init__ takes ({', '.join(init_names)})")
                break
        elif (set(init_names) - set(init_optional)) - ctor or ctor - set(init_names):
            issues.append(f"test {i} constructor keys {sorted(ctor)} do not match __init__({', '.join(init_names)})")
            break
        expected = t["expected"]
        if not isinstance(expected, list) or len(expected) != len(ops):
            issues.append(f"test {i}: expected must be a list with one entry per operation ({len(ops)})")
            break
        for j, op in enumerate(ops):
            if not isinstance(op, list) or not op or not isinstance(op[0], str):
                issues.append(f"test {i} operation {j} must be [method, *args]")
                break
            m = methods.get(op[0])
            if m is None:
                issues.append(f"test {i} calls {op[0]}(), which the starter class does not define")
                break
            names, optional, _, has_varargs = params(m)
            names = names[1:]
            nargs = len(op) - 1
            if not has_varargs and not (len(names) - len([n for n in optional if n in names]) <= nargs <= len(names)):
                issues.append(f"test {i} calls {op[0]} with {nargs} argument(s); the starter takes ({', '.join(names)})")
                break
        else:
            continue
        break
    return issues


problems = json.load(sys.stdin)
print(json.dumps([{"id": p.get("id"), "issues": lint(p)} for p in problems]))
