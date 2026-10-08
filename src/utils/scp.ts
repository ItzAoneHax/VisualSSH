/**
 * scp 命令拼装（第五阶段块 D1）：文件/多选右键「复制 scp 命令」。
 * 路径原样输出不做转义（提示词约定，报告注明）；远端路径逐个双引号包裹。
 */
export interface ScpTarget {
  host: string;
  port: number;
  username: string;
}

/** scp -P <port> "<user>@<host>:<absPath>" .（端口非 22 才带 -P；多路径空格连接） */
export function buildScpCommand(target: ScpTarget, absPaths: string[]): string {
  const prefix = target.port !== 22 ? `scp -P ${target.port} ` : "scp ";
  const specs = absPaths.map((p) => `"${target.username}@${target.host}:${p}"`);
  return `${prefix}${specs.join(" ")} .`;
}
