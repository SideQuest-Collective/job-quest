# app/lib/codelab/skeleton.py
# Turns a reference solution into starter code: imports and signatures kept, bodies replaced by `pass`.
# stdin: JSON list of {"id", "code", "entry"}. stdout: JSON {id: starter or null}.
import ast, json, sys


def strip(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        node.body = [ast.Pass()]
        return node
    if isinstance(node, ast.ClassDef):
        body = []
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                body.append(strip(item))
            elif isinstance(item, ast.AnnAssign):
                body.append(item)  # dataclass-style fields are part of the interface
        node.body = body or [ast.Pass()]
        return node
    return node


def skeleton(code, entry):
    tree = ast.parse(code)
    keep = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            keep.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name == entry:
            keep.append(strip(node))
    if not any(getattr(n, "name", None) == entry for n in keep):
        return None
    return ast.unparse(ast.Module(body=keep, type_ignores=[])) + "\n"


out = {}
for item in json.load(sys.stdin):
    try:
        out[item["id"]] = skeleton(item["code"], item["entry"])
    except SyntaxError:
        out[item["id"]] = None
print(json.dumps(out))
