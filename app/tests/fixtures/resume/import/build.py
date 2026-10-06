import sys, os, re
def esc(s): return s.replace("&",r"\&")
def role(t,team,dates,bs): return t
exp="\\section{Experience}\n\\cventrystart\n\n  \\vspace{0pt}\\item[]\n    \\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\n      \\textbf{Globex Corp} & \\small Jun 2018 -- Present \\\\\n    \\end{tabular*}\\vspace{-4pt}\n\n"
exp+=role("Senior Software Engineer","Billing Platform","Feb 2023 -- Present",EXP['sr'])
exp+=role("Software Engineer II","Billing Platform","Jan 2021 -- Feb 2023",EXP['ii'])
exp+=role("Software Engineer I",r"Internal Tools \& Reporting","Jun 2018 -- Jan 2021",EXP['i'])
