function regex_exec(str: string, r: RegExp | string) {
  const regex = new RegExp(r);

  return regex.exec(str) as RegExpExecArray;
}

export { regex_exec };
