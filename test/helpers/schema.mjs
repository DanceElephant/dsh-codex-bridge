/**
 * 极简 JSON Schema 校验器：只实现本项目工具 schema 用到的子集。
 *
 * 支持 type / enum / properties / required / additionalProperties:false / items。
 * 用于断言"工具返回值与它自己声明的 schema 一致"——宿主在真实调用时就是这么校验的，
 * 一旦字段类型不符（例如把 null 当 string）整个工具调用会失败。
 */
export function validate(value, schema, path = '$') {
  const errors = []
  if (schema === undefined || schema === null) return errors

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) errors.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
    return errors
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} 应为 string，实际 ${describe(value)}`)
      return errors
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${path} 应为 number，实际 ${describe(value)}`)
      return errors
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} 应为 boolean，实际 ${describe(value)}`)
      return errors
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} 应为 array，实际 ${describe(value)}`)
        return errors
      }
      value.forEach((item, index) => errors.push(...validate(item, schema.items, `${path}[${index}]`)))
      return errors
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path} 应为 object，实际 ${describe(value)}`)
        return errors
      }
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${path}.${key} 缺失（required）`)
      }
      const properties = schema.properties ?? {}
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) errors.push(`${path}.${key} 不在 schema 里（additionalProperties:false）`)
        }
      }
      for (const [key, inner] of Object.entries(value)) {
        if (key in properties) errors.push(...validate(inner, properties[key], `${path}.${key}`))
      }
      return errors
    }
    default:
      return errors
  }
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
