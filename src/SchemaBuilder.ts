import Ajv, { Options, ValidateFunction } from "ajv"
import {
    AllOf,
    Combine,
    DeepPartial,
    Merge,
    Nullable,
    ObjectSchemaDefinition,
    OneOf,
    Overwrite,
    PartialProperties,
    Rename,
    RequiredProperties,
    TransformProperties,
    TransformPropertiesToArray,
    UnwrapArrayProperties,
} from "./TransformationTypes.js"
import { JSONSchema, JSONSchemaTypeName } from "./JsonSchema.js"
import { cloneJSON, setRequired, throughJsonSchema } from "./utils.js"

import { JsonSchemaType } from "./JsonSchemaType.js"
import VError from "verror"
import _ from "lodash"
import addFormats from "ajv-formats"
import { createPropertyAccessor } from "./PropertyAccessor.js"

/**
 * Represents a JSON Schema and its type.
 */
export class SchemaBuilder<T> {
    private static globalAJVConfig: Options = {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: true,
        strict: false,
        allErrors: true,
    }
    private static globalAJVConfigVersionNumber = 0
    private localValidationFunctionVersionNumber: number = 0
    private localListValidationFunctionVersionNumber: number = 0

    /**
     * Sets the global validation configuration for the schema builder.
     * This method merges the provided configuration with the existing global configuration
     * Will invalidate all the existing cached validation functions.
     */
    static setGlobalValidationConfig(config: Options) {
        this.globalAJVConfig = { ...this.globalAJVConfig, ...config }
        this.globalAJVConfigVersionNumber++
    }
    static get globalAJVValidationConfig() {
        return this.globalAJVConfig
    }

    /**
     * Get the JSON schema object
     */
    public get schema() {
        return this.schemaObject
    }

    /**
     * Initialize a new SchemaBuilder instance.
     * /!\ schemaObject must not contain references. If you have references, use something like json-schema-ref-parser library first.
     */
    constructor(protected schemaObject: JSONSchema, protected validationConfig?: Options) {
        throughJsonSchema(this.schemaObject, (s) => {
            if ("$ref" in s) {
                throw new VError(`Schema Builder Error: $ref can't be used to initialize a SchemaBuilder. Dereferenced the schema first.`)
            }
        })
    }

    /**
     * Function that take an inline JSON schema and deduces its type automatically!
     * The schema has to be provided as a literal using `as const`
     */
    static fromJsonSchema<S>(schema: S, validationConfig?: Options) {
        return new SchemaBuilder<JsonSchemaType<S>>(schema as any, validationConfig)
    }

    /**
     * Create an empty object schema
     * AdditionalProperties is automatically set to false
     */
    static emptySchema<N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaObjectProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<{} | null> : SchemaBuilder<{}> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["object", "null"] : "object",
            additionalProperties: false,
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create the schema of an object with its properties. Takes a map of properties to their schema with optional properties surrounded by brackets.
     * @example: {
     *   s: SB.stringSchema(),
     *   b: [SB.booleanSchema(), undefined]
     * }
     * => outputs type {
     *   s: string,
     *   b?: boolean
     * }
     */
    static objectSchema<P extends { [k: string]: SchemaBuilder<any> | (SchemaBuilder<any> | undefined)[] }, N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaObjectProperties>,
        propertiesDefinition: P,
        nullable?: N,
    ): N extends true ? SchemaBuilder<ObjectSchemaDefinition<P> | null> : SchemaBuilder<ObjectSchemaDefinition<P>> {
        const required = [] as string[]
        const properties = {} as NonNullable<JSONSchema["properties"]>
        for (const property in propertiesDefinition) {
            const propertySchema = propertiesDefinition[property]
            if (!Array.isArray(propertySchema) || propertySchema.findIndex((e) => e === undefined) === -1) {
                required.push(property)
            }
            const filteredPropertySchema = Array.isArray(propertySchema) ? propertySchema.filter(<T>(v: T): v is NonNullable<T> => !!v) : propertySchema
            properties[property] = Array.isArray(filteredPropertySchema)
                ? filteredPropertySchema.length === 1 && filteredPropertySchema[0]
                    ? cloneJSON(filteredPropertySchema[0].schema)
                    : {
                          anyOf: filteredPropertySchema.map((builder) => cloneJSON((builder as SchemaBuilder<any>).schemaObject)),
                      }
                : cloneJSON(filteredPropertySchema.schema)
        }
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["object", "null"] : "object",
            ...(Object.keys(properties).length ? { properties } : {}),
            ...(required.length > 0 ? { required } : {}),
            additionalProperties: false,
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a string schema
     */
    static stringSchema<N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaStringProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<string | null> : SchemaBuilder<string> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["string", "null"] : "string",
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a number schema
     */
    static numberSchema<N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaNumberProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<number | null> : SchemaBuilder<number> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["number", "null"] : "number",
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create an integer schema
     */
    static integerSchema<N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaNumberProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<number | null> : SchemaBuilder<number> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["integer", "null"] : "integer",
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a boolean schema
     */
    static booleanSchema<N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaBooleanProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<boolean | null> : SchemaBuilder<boolean> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["boolean", "null"] : "boolean",
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a null schema
     */
    static nullSchema(schema: Pick<JSONSchema, JSONSchemaCommonProperties> = {}): SchemaBuilder<null> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: "null",
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a schema that can represent any value
     */
    static anySchema(schema: Pick<JSONSchema, JSONSchemaCommonProperties> = {}): SchemaBuilder<any> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a schema that can represent no value
     */
    static noneSchema(schema: Pick<JSONSchema, JSONSchemaCommonProperties> = {}): SchemaBuilder<any> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: [],
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create an enum schema
     * For array values, using "as const" make the typing a literal union if narrowing type is wanted.
     */
    static enumSchema<K extends string | number | boolean | null, N extends boolean = false>(
        values: K | readonly K[],
        schema: Pick<JSONSchema, JSONSchemaEnumProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<K | null> : SchemaBuilder<K> {
        const valuesArray = Array.isArray(values) ? values : [values]
        const types = [] as JSONSchemaTypeName[]
        for (let value of valuesArray) {
            if (typeof value === "string" && !types.find((type) => type === "string")) {
                types.push("string")
            }
            if (typeof value === "boolean" && !types.find((type) => type === "boolean")) {
                types.push("boolean")
            }
            if (typeof value === "number" && !types.find((type) => type === "number")) {
                types.push("number")
            }
        }
        if (nullable) {
            types.push("null")
        }
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: types.length === 1 ? types[0] : types,
            enum: nullable && valuesArray.findIndex((v) => v === null) === -1 ? [...valuesArray, null] : [...valuesArray],
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a constant schema. Useful for narrowing types.
     */
    static constSchema<K extends string | number | boolean | null>(value: K, schema: Pick<JSONSchema, JSONSchemaEnumProperties> = {}): SchemaBuilder<K> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            const: value,
        }

        return new SchemaBuilder(s) as any
    }

    /**
     * Create an array schema
     */
    static arraySchema<U, N extends boolean = false>(
        items: SchemaBuilder<U>,
        schema: Pick<JSONSchema, JSONSchemaArrayProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<U[] | null> : SchemaBuilder<U[]> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["array", "null"] : "array",
            items: cloneJSON(items.schemaObject),
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Create a date schema with ISO 8601 format (date-time)
     */
    static dateSchema<N extends boolean = false>(
        schema: Pick<JSONSchema, JSONSchemaStringProperties> = {},
        nullable?: N,
    ): N extends true ? SchemaBuilder<Date | null> : SchemaBuilder<Date> {
        let s: JSONSchema = {
            ...cloneJSON(schema),
            type: nullable ? ["string", "null"] : "string",
            format: "date-time",
        }
        return new SchemaBuilder(s) as any
    }

    /**
     * Return a schema builder which validate any one of the provided schemas exclusively. "oneOf" as described by JSON Schema specifications.
     */
    static oneOf<S extends SchemaBuilder<any>[]>(...schemaBuilders: S): SchemaBuilder<OneOf<S>> {
        return new SchemaBuilder<any>({
            oneOf: schemaBuilders.map((builder) => cloneJSON(builder.schemaObject)),
        })
    }

    /**
     * Return a schema builder which validate all the provided schemas. "allOf" as described by JSON Schema specifications.
     */
    static allOf<S extends SchemaBuilder<any>[]>(...schemaBuilders: S): SchemaBuilder<AllOf<S>> {
        return new SchemaBuilder<any>({
            allOf: schemaBuilders.map((builder) => cloneJSON(builder.schemaObject)),
        })
    }

    /**
     * Return a schema builder which validate any number the provided schemas. "anyOf" as described by JSON Schema specifications.
     */
    static anyOf<S extends SchemaBuilder<any>[]>(...schemaBuilders: S): SchemaBuilder<OneOf<S>> {
        return new SchemaBuilder<any>({
            anyOf: schemaBuilders.map((builder) => cloneJSON(builder.schemaObject)),
        })
    }

    /**
     * Return a schema builder which represents the negation of the given schema. The only type we can assume is "any". "not" as described by JSON Schema specifications.
     */
    static not(schemaBuilder: SchemaBuilder<any>) {
        return new SchemaBuilder<any>({
            not: cloneJSON(schemaBuilder.schemaObject),
        })
    }

    /**
     * Make given properties optionals
     */
    setOptionalProperties<K extends keyof T>(properties: readonly K[]): SchemaBuilder<{ [P in keyof PartialProperties<T, K>]: PartialProperties<T, K>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'setOptionalProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        const required = _.difference(schemaObject.required ?? [], properties as readonly string[])
        // clear default values for optional properties
        for (let optionalProperty of properties) {
            let property = schemaObject.properties?.[optionalProperty as string]
            if (property && typeof property !== "boolean") {
                delete property.default
            }
        }

        // delete required array if empty
        setRequired(schemaObject, required)
        return new SchemaBuilder(schemaObject, this.validationConfig)
    }

    /**
     * Make given properties required
     */
    setRequiredProperties<K extends keyof T>(properties: readonly K[]): SchemaBuilder<{ [P in keyof RequiredProperties<T, K>]: RequiredProperties<T, K>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'setRequiredProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        for (let property of properties) {
            schemaObject.required = schemaObject.required || []
            if (schemaObject.required.indexOf(property as string) === -1) {
                schemaObject.required.push(property as string)
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig)
    }

    /**
     * Make all properties optionals and remove their default values
     */
    toOptionals(): SchemaBuilder<{
        [P in keyof T]?: T[P]
    }> {
        let schemaObject = cloneJSON(this.schemaObject)
        delete schemaObject.required
        // remove default values for optional properties
        for (let property in schemaObject.properties) {
            delete (schemaObject.properties[property] as JSONSchema).default
        }
        return new SchemaBuilder(schemaObject, this.validationConfig)
    }

    /**
     * Make all properties and subproperties optionals
     * Remove all default values
     */
    toDeepOptionals(): SchemaBuilder<{ [P in keyof DeepPartial<T>]: DeepPartial<T>[P] }> {
        let schemaObject = cloneJSON(this.schemaObject)
        throughJsonSchema(schemaObject, (s) => {
            delete s.required
            // optional properties can't have default values
            delete s.default
        })
        return new SchemaBuilder(schemaObject, this.validationConfig)
    }

    /**
     * Make all optional properties of this schema nullable
     */
    toNullable(): SchemaBuilder<{ [P in keyof Nullable<T>]: Nullable<T>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'toNullable' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        let required = schemaObject.required || []
        for (let propertyName in schemaObject.properties) {
            if (required.indexOf(propertyName) === -1) {
                let propertyValue = schemaObject.properties[propertyName]
                if (typeof propertyValue !== "boolean" && "type" in propertyValue) {
                    if (Array.isArray(propertyValue.type) && propertyValue.type.indexOf("null") === -1) {
                        propertyValue.type = [...propertyValue.type, "null"]
                    } else if (typeof propertyValue.type === "string" && propertyValue.type !== "null") {
                        propertyValue.type = [propertyValue.type, "null"]
                    }
                    if ("enum" in propertyValue && propertyValue.enum?.indexOf(null) === -1) {
                        propertyValue.enum = [...propertyValue.enum, null]
                    }
                } else {
                    schemaObject.properties[propertyName] = {
                        anyOf: [schemaObject.properties[propertyName], { type: "null" }],
                    }
                }
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Add a property using the given schema builder
     */
    addProperty<U, K extends keyof any, REQUIRED extends boolean = true>(
        propertyName: K,
        schemaBuilder: SchemaBuilder<U>,
        isRequired?: REQUIRED,
    ): SchemaBuilder<{ [P in keyof Combine<T, U, K, REQUIRED, false>]: Combine<T, U, K, REQUIRED, false>[P] }> {
        if (!this.isObjectSchema) {
            throw new VError(`Schema Builder Error: you can only add properties to an object schema`)
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        if (propertyName in schemaObject.properties) {
            throw new VError(`Schema Builder Error: '${propertyName as string}' already exists in ${schemaObject.title || "this"} schema`)
        }
        schemaObject.properties[propertyName as string] = cloneJSON(schemaBuilder.schemaObject)
        if (isRequired === true || isRequired === undefined) {
            schemaObject.required = schemaObject.required || []
            schemaObject.required.push(propertyName as string)
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Replace an existing property of this schema
     */
    replaceProperty<U, K extends keyof T, REQUIRED extends boolean = true>(
        propertyName: K,
        schemaBuilderResolver: SchemaBuilder<U> | ((s: SchemaBuilder<T[K]>) => SchemaBuilder<U>),
        isRequired?: REQUIRED,
    ): SchemaBuilder<{ [P in keyof Combine<Omit<T, K>, U, K, REQUIRED, false>]: Combine<Omit<T, K>, U, K, REQUIRED, false>[P] }> {
        if (!this.isObjectSchema) {
            throw new VError(`Schema Builder Error: you can only replace properties of an object schema`)
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        if (schemaObject.required) {
            schemaObject.required = schemaObject.required.filter((p: string) => p !== propertyName)
        }
        const schemaBuilder = typeof schemaBuilderResolver === "function" ? schemaBuilderResolver(this.getSubschema(propertyName)) : schemaBuilderResolver
        schemaObject.properties[propertyName as string] = cloneJSON(schemaBuilder.schemaObject)
        if (isRequired === true || isRequired === undefined) {
            schemaObject.required = schemaObject.required || []
            schemaObject.required.push(propertyName as string)
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Add a property or replace it if it already exists using the given schema builder
     */
    addOrReplaceProperty<U, K extends keyof any, REQUIRED extends boolean = true>(
        propertyName: K,
        schemaBuilder: SchemaBuilder<U>,
        isRequired?: REQUIRED,
    ): SchemaBuilder<{ [P in keyof Combine<Omit<T, K>, U, K, REQUIRED, false>]: Combine<Omit<T, K>, U, K, REQUIRED, false>[P] }> {
        return this.replaceProperty(propertyName as any, schemaBuilder, isRequired) as any
    }

    /**
     * Add additional properties schema.
     * /!\ Many type operations can't work properly with index signatures. Try to use additionalProperties at the last step of your SchemaBuilder definition.
     * /!\ In typescript index signature MUST be compatible with other properties. However its supported in JSON schema, you can use it but you have to force the index singature to any.
     */
    addAdditionalProperties<U = any>(schemaBuilder?: SchemaBuilder<U>): SchemaBuilder<T & { [P: string]: U }> {
        if (this.schemaObject.additionalProperties) {
            throw new VError(`Schema Builder Error: additionalProperties is already set in ${this.schemaObject.title || "this"} schema.`)
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.additionalProperties = schemaBuilder ? cloneJSON(schemaBuilder.schemaObject) : true
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Add pattern properties to schema.
     */
    addPatternProperty<U = any, PPK extends string = "", SPK extends string = "">(
        prefixPattern: PPK,
        suffixPattern: SPK,
        schemaBuilder: SchemaBuilder<U> | true = true,
    ): SchemaBuilder<{ [Key in keyof T | `${PPK}${string}${SPK}`]: Key extends keyof T ? T[Key] : U }> {
        const newPatternKey = `^${prefixPattern}.*${suffixPattern}$`
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.patternProperties = {
            ...schemaObject.patternProperties,
            [newPatternKey]: schemaBuilder === true ? true : cloneJSON(schemaBuilder.schemaObject),
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Add multiple properties to the schema using the same kind of definition as `objectSchema` static method
     */
    addProperties<P extends { [k: string]: SchemaBuilder<any> | (SchemaBuilder<any> | undefined)[] }>(
        propertiesDefinition: P,
    ): SchemaBuilder<{ [K in keyof (T & ObjectSchemaDefinition<P>)]: (T & ObjectSchemaDefinition<P>)[K] }> {
        if (!this.isObjectSchema) {
            throw new VError(`Schema Builder Error: you can only add properties to an object schema`)
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        const propertiesIntersection = _.intersection(Object.keys(schemaObject.properties), Object.keys(propertiesDefinition))
        if (propertiesIntersection.length) {
            throw new VError(`Schema Builder Error: '${propertiesIntersection.join(", ")}' already exists in ${schemaObject.title || "this"} schema`)
        }
        for (const propertyName in propertiesDefinition) {
            const propertySchema = propertiesDefinition[propertyName]
            const filteredPropertySchema = Array.isArray(propertySchema) ? propertySchema.filter(<T>(v: T): v is NonNullable<T> => !!v) : propertySchema
            schemaObject.properties[propertyName as string] = Array.isArray(filteredPropertySchema)
                ? filteredPropertySchema.length === 1 && filteredPropertySchema[0]
                    ? cloneJSON(filteredPropertySchema[0].schema)
                    : {
                          anyOf: filteredPropertySchema.map((builder) => cloneJSON((builder as SchemaBuilder<any>).schemaObject)),
                      }
                : cloneJSON(filteredPropertySchema.schema)
            if (!Array.isArray(propertySchema) || propertySchema.findIndex((e) => e === undefined) === -1) {
                schemaObject.required = schemaObject.required || []
                schemaObject.required.push(propertyName as string)
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Add a string to the schema properties
     */
    addString<K extends keyof any, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        schema: Pick<JSONSchema, JSONSchemaStringProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, string, K, REQUIRED, N>]: Combine<T, string, K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.stringSchema(schema, nullable), isRequired) as any
    }

    /**
     * Add an enum to the schema properties
     */
    addEnum<K extends keyof any, K2 extends string | boolean | number | null, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        values: readonly K2[],
        schema: Pick<JSONSchema, JSONSchemaEnumProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, K2, K, REQUIRED, N>]: Combine<T, K2, K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.enumSchema(values, schema, nullable), isRequired) as any
    }

    /**
     * Add a number to the schema properties
     */
    addNumber<K extends keyof any, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        schema: Pick<JSONSchema, JSONSchemaNumberProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, number, K, REQUIRED, N>]: Combine<T, number, K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.numberSchema(schema, nullable), isRequired) as any
    }

    /**
     * Add an integer to the schema properties
     */
    addInteger<K extends keyof any, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        schema: Pick<JSONSchema, JSONSchemaNumberProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, number, K, REQUIRED, N>]: Combine<T, number, K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.integerSchema(schema, nullable), isRequired) as any
    }

    /**
     * Add a number to the schema properties
     */
    addBoolean<K extends keyof any, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        schema: Pick<JSONSchema, JSONSchemaBooleanProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, boolean, K, REQUIRED, N>]: Combine<T, boolean, K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.booleanSchema(schema, nullable), isRequired) as any
    }

    /**
     * Add an array of objects to the schema properties
     */
    addArray<U extends {}, K extends keyof any, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        items: SchemaBuilder<U>,
        schema: Pick<JSONSchema, JSONSchemaArrayProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, U[], K, REQUIRED, N>]: Combine<T, U[], K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.arraySchema(items, schema, nullable), isRequired) as any
    }

    /**
     * Add a date property (ISO 8601 format) to the schema properties
     */
    addDate<K extends keyof any, REQUIRED extends boolean = true, N extends boolean = false>(
        propertyName: K,
        schema: Pick<JSONSchema, JSONSchemaStringProperties> = {},
        isRequired?: REQUIRED,
        nullable?: N,
    ): SchemaBuilder<{ [P in keyof Combine<T, Date, K, REQUIRED, N>]: Combine<T, Date, K, REQUIRED, N>[P] }> {
        return this.addProperty(propertyName, SchemaBuilder.dateSchema(schema, nullable), isRequired) as any
    }

    /**
     * Rename the given property. The property schema remains unchanged.
     */
    renameProperty<K extends keyof T, K2 extends keyof any>(
        propertyName: K,
        newPropertyName: K2,
    ): SchemaBuilder<{ [P in keyof Rename<T, K, K2>]: Rename<T, K, K2>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'renameProperty' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        if (propertyName in schemaObject.properties) {
            schemaObject.properties[newPropertyName as string] = schemaObject.properties[propertyName as string]
            delete schemaObject.properties[propertyName as string]
            // rename the property in the required array if needed
            if (schemaObject.required && schemaObject.required.indexOf(propertyName as string) !== -1) {
                schemaObject.required.splice(schemaObject.required.indexOf(propertyName as string), 1)
                schemaObject.required.push(newPropertyName as string)
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Filter the schema to contains only the given properties. additionalProperties is set to false.
     *
     * @param properties name of properties of T to keep in the result
     */
    pickProperties<K extends keyof T>(properties: readonly K[]): SchemaBuilder<{ [P in K]: T[P] }> {
        if (!this.isObjectSchema || this.hasSchemasCombinationKeywords) {
            throw new VError(`Schema Builder Error: 'pickProperties' can only be used with a simple object schema (no oneOf, anyOf, allOf or not)`)
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        let propertiesMap: any = {}
        for (let property of properties) {
            propertiesMap[property] = schemaObject.properties[property as string]
        }
        schemaObject.properties = propertiesMap
        if (schemaObject.required) {
            schemaObject.required = schemaObject.required.filter((r: string) => (properties as readonly string[]).indexOf(r) !== -1)
        }
        if (Array.isArray(schemaObject.required) && schemaObject.required.length === 0) {
            delete schemaObject.required
        }
        schemaObject.additionalProperties = false
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Filter the schema to contains only the given properties and keep additionalProperties or part of it
     *
     * @param properties
     * @param additionalProperties [] means no additional properties are kept in the result. undefined means additionalProperties is kept or set to true if it was not set to false. ['aProperty'] allows you to capture only specific names that conform to additionalProperties type.
     */
    pickAdditionalProperties<K extends keyof T, K2 extends keyof T & string = any>(
        properties: readonly K[],
        additionalProperties?: readonly K2[],
    ): SchemaBuilder<Pick<T, K> & { [P in K2]: T[P] }> {
        if (!this.isObjectSchema || !this.hasAdditionalProperties || this.hasSchemasCombinationKeywords) {
            throw new VError(
                `Schema Builder Error: 'pickPropertiesIncludingAdditonalProperties' can only be used with a simple object schema with additionalProperties (no oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        let additionalProps = schemaObject.additionalProperties
        schemaObject.properties = schemaObject.properties || {}
        let propertiesMap: {
            [key: string]: boolean | JSONSchema
        } = {}
        for (let property of properties) {
            propertiesMap[property as string] = schemaObject.properties[property as string]
        }
        schemaObject.properties = propertiesMap
        if (schemaObject.required) {
            schemaObject.required = schemaObject.required.filter((r: string) => (properties as readonly string[]).indexOf(r) !== -1)
        }
        if (Array.isArray(schemaObject.required) && schemaObject.required.length === 0) {
            delete schemaObject.required
        }
        if (!additionalProperties) {
            schemaObject.additionalProperties = additionalProps ? additionalProps : true
        } else if (Array.isArray(additionalProperties) && additionalProperties.length === 0) {
            schemaObject.additionalProperties = false
        } else {
            schemaObject.additionalProperties = false
            schemaObject.required = schemaObject.required || []
            if (additionalProps) {
                for (let additionalProperty of additionalProperties) {
                    schemaObject.properties[additionalProperty] = typeof additionalProps === "boolean" ? {} : cloneJSON(additionalProps)
                    schemaObject.required.push(additionalProperty)
                }
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Filter the schema to contains everything except the given properties.
     */
    omitProperties<K extends keyof T>(properties: readonly K[]): SchemaBuilder<{ [P in keyof Omit<T, K>]: Omit<T, K>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'omitProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let p = Object.keys(this.schemaObject.properties || {}).filter((k) => (properties as readonly string[]).indexOf(k) === -1)
        return this.pickProperties(p as any)
    }

    /**
     * Transform properties to accept an alternative type. additionalProperties is set false.
     *
     * @param changedProperties properties that will have the alternative type
     * @param schemaBuilder
     */
    transformProperties<U, K extends keyof T>(
        schemaBuilder: SchemaBuilder<U>,
        propertyNames?: readonly K[],
    ): SchemaBuilder<{ [P in keyof TransformProperties<T, K, U>]: TransformProperties<T, K, U>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'transformProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        propertyNames = propertyNames || (Object.keys(schemaObject.properties) as K[])
        for (let property of propertyNames) {
            let propertySchema = schemaObject.properties[property as string]
            schemaObject.properties[property as string] = {
                oneOf: [propertySchema, cloneJSON(schemaBuilder.schemaObject)],
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Transform the given properties to make them alternatively an array of the initial type.
     * If the property is already an Array nothing happen.
     *
     * @param propertyNames properties that will have the alternative array type
     * @param schema Array schema options to add to the transformed properties
     */
    transformPropertiesToArray<K extends keyof T>(
        propertyNames?: readonly K[],
        schema: Pick<JSONSchema, JSONSchemaArraySpecificProperties> = {},
    ): SchemaBuilder<{ [P in keyof TransformPropertiesToArray<T, K>]: TransformPropertiesToArray<T, K>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'transformPropertiesToArray' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        propertyNames = propertyNames || (Object.keys(schemaObject.properties) as K[])
        for (let property of propertyNames) {
            let propertySchema = schemaObject.properties[property as string]
            // Transform the property if it's not an array
            if ((propertySchema as JSONSchema).type !== "array") {
                schemaObject.properties[property as string] = {
                    oneOf: [propertySchema, { type: "array", items: cloneJSON(propertySchema), ...schema }],
                }
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Unwrap the given array properties to make them alternatively the generic type of the array
     * If the property is not an Array nothing happen.
     *
     * @param propertyNames properties that will be unwrapped
     */
    unwrapArrayProperties<K extends keyof T>(
        propertyNames?: readonly K[],
    ): SchemaBuilder<{ [P in keyof UnwrapArrayProperties<T, K>]: UnwrapArrayProperties<T, K>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'unwrapArrayProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject = cloneJSON(this.schemaObject)
        schemaObject.properties = schemaObject.properties || {}
        propertyNames = propertyNames || (Object.keys(schemaObject.properties) as K[])
        for (let property of propertyNames) {
            let propertySchema = schemaObject.properties[property as string]
            // Transform the property if it's an array
            if ((propertySchema as JSONSchema).type === "array") {
                let items = (propertySchema as JSONSchema).items
                let itemsSchema: JSONSchema
                if (Array.isArray(items)) {
                    if (items.length === 1) {
                        itemsSchema = items[0] as JSONSchema
                    } else {
                        itemsSchema = { oneOf: items }
                    }
                } else {
                    itemsSchema = items as JSONSchema
                }
                schemaObject.properties[property as string] = {
                    oneOf: [cloneJSON(itemsSchema), propertySchema],
                }
            }
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Merge all properties from the given schema into this one. If a property name is already used, a allOf statement is used.
     * This method only copy properties.
     */
    intersectProperties<T2>(schema: SchemaBuilder<T2>): SchemaBuilder<{ [P in keyof (T & T2)]: (T & T2)[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'intersectProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject1 = cloneJSON(this.schemaObject)
        let schemaObject2 = cloneJSON(schema.schemaObject)
        if (schemaObject2.properties) {
            schemaObject1.properties = schemaObject1.properties || {}
            for (let propertyKey in schemaObject2.properties) {
                if (!(propertyKey in schemaObject1.properties)) {
                    schemaObject1.properties[propertyKey] = schemaObject2.properties[propertyKey]
                    if (schemaObject2.required && schemaObject2.required.indexOf(propertyKey) !== -1) {
                        schemaObject1.required = schemaObject1.required || []
                        schemaObject1.required.push(propertyKey)
                    }
                } else {
                    schemaObject1.properties[propertyKey] = {
                        allOf: [schemaObject1.properties[propertyKey], schemaObject2.properties[propertyKey]],
                    }
                    if (
                        schemaObject2.required &&
                        schemaObject2.required.indexOf(propertyKey) !== -1 &&
                        (!schemaObject1.required || schemaObject1.required.indexOf(propertyKey) === -1)
                    ) {
                        schemaObject1.required = schemaObject1.required || []
                        schemaObject1.required.push(propertyKey)
                    }
                }
            }
        }
        return new SchemaBuilder(schemaObject1, this.validationConfig) as any
    }

    /**
     * Merge all properties from the given schema into this one. If a property name is already used, a anyOf statement is used.
     * This method only copy properties.
     */
    mergeProperties<T2>(schema: SchemaBuilder<T2>): SchemaBuilder<{ [P in keyof Merge<T, T2>]: Merge<T, T2>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'mergeProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject1 = cloneJSON(this.schemaObject)
        let schemaObject2 = cloneJSON(schema.schemaObject)
        if (schemaObject2.properties) {
            schemaObject1.properties = schemaObject1.properties || {}
            for (let propertyKey in schemaObject2.properties) {
                if (!(propertyKey in schemaObject1.properties)) {
                    schemaObject1.properties[propertyKey] = schemaObject2.properties[propertyKey]
                    if (schemaObject2.required && schemaObject2.required.indexOf(propertyKey) !== -1) {
                        schemaObject1.required = schemaObject1.required || []
                        schemaObject1.required.push(propertyKey)
                    }
                } else {
                    schemaObject1.properties[propertyKey] = {
                        anyOf: [schemaObject1.properties[propertyKey], schemaObject2.properties[propertyKey]],
                    }
                    if (
                        schemaObject1.required &&
                        schemaObject1.required.indexOf(propertyKey) !== -1 &&
                        (!schemaObject2.required || schemaObject2.required.indexOf(propertyKey) === -1)
                    ) {
                        schemaObject1.required = schemaObject1.required.filter((p: string) => p !== propertyKey)
                    }
                }
            }
        }
        return new SchemaBuilder(schemaObject1, this.validationConfig) as any
    }

    /**
     * Overwrite all properties from the given schema into this one. If a property name is already used, the new type override the existing one.
     * This method only copy properties.
     */
    overwriteProperties<T2>(schema: SchemaBuilder<T2>): SchemaBuilder<{ [P in keyof Overwrite<T, T2>]: Overwrite<T, T2>[P] }> {
        if (!this.isSimpleObjectSchema) {
            throw new VError(
                `Schema Builder Error: 'overwriteProperties' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        }
        let schemaObject1 = cloneJSON(this.schemaObject)
        let schemaObject2 = cloneJSON(schema.schemaObject)
        if (schemaObject2.properties) {
            schemaObject1.properties = schemaObject1.properties || {}
            for (let propertyKey in schemaObject2.properties) {
                if (!(propertyKey in schemaObject1.properties)) {
                    schemaObject1.properties[propertyKey] = schemaObject2.properties[propertyKey]
                    if (schemaObject2.required && schemaObject2.required.indexOf(propertyKey) !== -1) {
                        schemaObject1.required = schemaObject1.required || []
                        schemaObject1.required.push(propertyKey)
                    }
                } else {
                    schemaObject1.properties[propertyKey] = schemaObject2.properties[propertyKey]
                    if (schemaObject1.required && schemaObject1.required.indexOf(propertyKey) !== -1) {
                        schemaObject1.required = schemaObject1.required.filter((r: string) => r !== propertyKey)
                    }
                    if (schemaObject2.required && schemaObject2.required.indexOf(propertyKey) !== -1) {
                        schemaObject1.required = schemaObject1.required || []
                        schemaObject1.required.push(propertyKey)
                    }
                }
            }
        }
        return new SchemaBuilder(schemaObject1, this.validationConfig) as any
    }

    /**
     * Extract a subschema of the current object schema
     */
    getSubschema<K extends keyof T>(propertyName: K) {
        if (!this.isSimpleObjectSchema || !this.schemaObject || typeof this.schemaObject === "boolean" || !this.schemaObject.properties) {
            throw new VError(
                `Schema Builder Error: 'getSubschema' can only be used with a simple object schema (no additionalProperties, oneOf, anyOf, allOf or not)`,
            )
        } else {
            return new SchemaBuilder<NonNullable<T[K]>>(this.schemaObject.properties[propertyName as string] as JSONSchema)
        }
    }

    /**
     * Extract the item schema of the current array schema
     */
    getItemsSubschema() {
        if (!this.schemaObject || !this.isArraySchema || !this.schemaObject.items || Array.isArray(this.schemaObject.items)) {
            throw new VError(`Schema Builder Error: 'getItemsSubschema' can only be used with an array schema with non-array items`)
        } else {
            return new SchemaBuilder<T extends Array<infer ITEMS> ? ITEMS : never>(this.schemaObject.items as JSONSchema)
        }
    }

    /**
     * Determine if the 'type' property of the schema contains the given type
     */
    hasType(type: JSONSchemaTypeName) {
        return !!this.schemaObject && (Array.isArray(this.schemaObject.type) ? this.schemaObject.type.includes(type) : this.schemaObject.type === type)
    }

    /**
     * Build a property accessor starting from this schema type
     * @returns a property accessor for the type represented by the schema
     */
    getPropertyAccessor() {
        return createPropertyAccessor(this as SchemaBuilder<T>)
    }

    /**
     * true if additionalProperties is set to false and, oneOf, allOf, anyOf and not are not used
     */
    get isSimpleObjectSchema() {
        return this.isObjectSchema && !this.hasAdditionalProperties && !this.hasSchemasCombinationKeywords
    }

    /**
     * true if the schema represent an object
     */
    get isObjectSchema() {
        return this.hasType("object") || (!("type" in this.schemaObject) && "properties" in this.schemaObject)
    }

    /**
     * true if the schema represent an array
     */
    get isArraySchema() {
        return this.hasType("array") || (!("type" in this.schemaObject) && "items" in this.schemaObject)
    }

    /**
     * True if the schema represents an objet that can have additional properties
     */
    get hasAdditionalProperties() {
        return this.isObjectSchema && this.schemaObject.additionalProperties !== false
    }

    /**
     * True if the schema contains oneOf, allOf, anyOf or not keywords
     */
    get hasSchemasCombinationKeywords() {
        return "oneOf" in this.schemaObject || "allOf" in this.schemaObject || "anyOf" in this.schemaObject || "not" in this.schemaObject
    }

    get properties(): string[] | null {
        if (this.isObjectSchema && !this.hasSchemasCombinationKeywords) {
            return Object.keys(this.schemaObject.properties || {})
        }
        return null
    }

    get requiredProperties(): string[] | null {
        if (this.isObjectSchema && !this.hasSchemasCombinationKeywords) {
            return this.schemaObject.required ? [...this.schemaObject.required] : []
        }
        return null
    }

    get optionalProperties(): string[] | null {
        const properties = this.properties
        const required = this.requiredProperties
        return properties ? properties.filter((property) => required && required.indexOf(property) === -1) : null
    }

    /**
     * change general schema attributes
     *
     * @property schema
     */
    setSchemaAttributes(schema: Pick<JSONSchema, JSONSchemaGeneralProperties>): SchemaBuilder<{ [P in keyof T]: T[P] }> {
        let schemaObject = {
            ...cloneJSON(this.schemaObject),
            ...schema,
        }
        return new SchemaBuilder(schemaObject, this.validationConfig) as any
    }

    /**
     * Validate the given object against the schema. If the object is invalid an error is thrown with the appropriate details.
     */
    validate(o: T) {
        // Convert Date objects to ISO strings before validation
        const transformedData = this.transformDatesForValidation(o)
        // ensure validation function is cached
        this.cacheValidationFunction()
        // run validation
        let valid = this.validationFunction(transformedData)
        // check if an error needs to be thrown
        if (!valid) {
            throw validationError(this.ajv.errorsText(this.validationFunction.errors), this.validationFunction.errors)
        }
    }

    /**
     * Transform Date objects to ISO 8601 strings for validation
     * @private
     */
    private transformDatesForValidation(data: any): any {
        if (data instanceof Date) {
            return data.toISOString()
        }

        if (Array.isArray(data)) {
            return data.map((item) => this.transformDatesForValidation(item))
        }

        if (data !== null && typeof data === "object") {
            const result: any = {}
            for (const key in data) {
                result[key] = this.transformDatesForValidation(data[key])
            }
            return result
        }

        return data
    }

    protected ajv!: Ajv
    protected validationFunction!: ValidateFunction<T>

    /**
     * Validate the given list of object against the schema. If any object is invalid, an error is thrown with the appropriate details.
     */
    validateList(list: T[]) {
        // Transform dates to ISO strings
        const transformedList = list.map((item) => this.transformDatesForValidation(item))
        // ensure validation function is cached
        this.cacheListValidationFunction()
        // run validation
        let valid = this.listValidationFunction(transformedList)
        // check if an error needs to be thrown
        if (!valid) {
            throw validationError(this.ajvList.errorsText(this.listValidationFunction.errors), this.listValidationFunction.errors)
        }
    }
    protected ajvList!: Ajv
    protected listValidationFunction!: ValidateFunction<T[]>

    /**
     * Change the default Ajv configuration to use the given values.
     * The default validation config is { coerceTypes: false, removeAdditional: false, useDefaults: true }
     */
    configureValidation(validationConfig: Options) {
        return new SchemaBuilder<T>(cloneJSON(this.schemaObject), validationConfig)
    }

    get ajvValidationConfig() {
        return {
            ...SchemaBuilder.globalAJVConfig,
            ...this.validationConfig,
        }
    }

    /**
     * Explicitly cache the validation function for single objects with the current validation configuration
     */
    cacheValidationFunction() {
        // prepare validation function
        if (!this.validationFunction || this.localValidationFunctionVersionNumber !== SchemaBuilder.globalAJVConfigVersionNumber) {
            this.localValidationFunctionVersionNumber = SchemaBuilder.globalAJVConfigVersionNumber
            this.ajv = new Ajv(this.ajvValidationConfig)

            // Add a custom format handler for date-time
            this.ajv.addFormat("date-time", {
                type: "string",
                validate: (dateTimeString: string) => {
                    try {
                        const date = new Date(dateTimeString)
                        return !isNaN(date.getTime())
                    } catch (e) {
                        return false
                    }
                },
            })

            addFormats(this.ajv)
            this.validationFunction = this.ajv.compile(this.schemaObject)
        }
    }
    /**
     * Explicitly cache the validation function for list of objects with the current validation configuration
     */
    cacheListValidationFunction() {
        // prepare validation function
        if (!this.listValidationFunction || this.localListValidationFunctionVersionNumber !== SchemaBuilder.globalAJVConfigVersionNumber) {
            this.localListValidationFunctionVersionNumber = SchemaBuilder.globalAJVConfigVersionNumber
            this.ajvList = new Ajv(this.ajvValidationConfig)
            addFormats(this.ajvList)
            this.ajvList.addSchema(this.schemaObject, "schema")
            this.listValidationFunction = this.ajvList.compile({
                type: "array",
                items: { $ref: "schema" },
                minItems: 1,
            })
        }
    }

    /**
     * Parse and validate JSON data, converting string date-time formats to Date objects
     * This method validates the input and converts ISO 8601 strings to JavaScript Date objects
     * based on the schema definition.
     *
     * @param data The JSON data to parse and validate
     * @returns The validated data with ISO 8601 strings converted to Date objects
     */
    parse<U extends Record<string, any>>(data: U): T {
        // Create a copy of the data to avoid modifying the original
        const dataCopy = JSON.parse(JSON.stringify(data))

        // Transform string numbers to actual numbers
        const transformedData = this.transformStringToNumber(dataCopy, this.schemaObject)

        // First validate the data to ensure it matches the schema
        this.validate(transformedData)

        // Then transform ISO date strings to Date objects
        return this.transformISOStringsToDate(transformedData, this.schemaObject)
    }

    /**
     * Transform data types before validation (e.g., string to number conversion)
     * @private
     */
    private transformStringToNumber<U>(data: U, schema?: JSONSchema): any {
        // Handle null or undefined
        if (data == null) {
            return data
        }

        // Handle strings that should be numbers based on schema
        if (typeof data === "string" && schema) {
            const schemaType = Array.isArray(schema.type) ? schema.type : [schema.type]

            // Check if schema defines this as a number or integer
            const isNumberField = schemaType.includes("number") || schemaType.includes("integer")

            if (isNumberField) {
                // Try to convert string to number if it's a valid number string
                const numValue = Number(data)
                if (!isNaN(numValue)) {
                    return schema.type === "integer" ? Math.floor(numValue) : numValue
                }
            }

            return data
        }

        // Handle arrays by processing each item
        if (Array.isArray(data)) {
            const itemSchema = schema?.items && !Array.isArray(schema.items) ? (schema.items as JSONSchema) : undefined
            return data.map((item) => this.transformStringToNumber(item, itemSchema))
        }

        // Handle objects by processing each property
        if (data !== null && typeof data === "object") {
            const result: Record<string, any> = {}

            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    const propertySchema = schema?.properties?.[key] as JSONSchema | undefined
                    result[key] = this.transformStringToNumber(data[key], propertySchema)
                }
            }

            return result
        }

        // Return other primitives as is
        return data
    }

    /**
     * Transform ISO 8601 strings to Date objects based on schema definition
     * @private
     */
    private transformISOStringsToDate<U>(data: U, schema?: JSONSchema): any {
        // Handle null or undefined
        if (data == null) {
            return data
        }

        // Handle Date objects (no transformation needed)
        if (data instanceof Date) {
            return data
        }

        // Handle strings that match date-time format based on schema or try to detect ISO format
        if (typeof data === "string") {
            // Check if schema explicitly defines this as a date-time format
            const isDateTimeField =
                schema && (schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"))) && schema.format === "date-time"

            // Try to detect ISO 8601 date format
            const isIsoDateString = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(data)

            if (isDateTimeField || isIsoDateString) {
                try {
                    const dateObj = new Date(data)
                    // Check if valid date (invalid dates like "2023-99-99" will parse but result in Invalid Date)
                    if (!isNaN(dateObj.getTime())) {
                        return dateObj
                    }
                } catch (e) {
                    // If date parsing fails, return original string
                }
            }
            return data
        }

        // Handle arrays by processing each item
        if (Array.isArray(data)) {
            const itemSchema = schema?.items && !Array.isArray(schema.items) ? (schema.items as JSONSchema) : undefined

            return data.map((item) => this.transformISOStringsToDate(item, itemSchema || {}))
        }

        // Handle objects by processing each property
        if (data !== null && typeof data === "object") {
            const result: Record<string, any> = {}

            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    const propertySchema = schema?.properties?.[key] as JSONSchema | undefined
                    result[key] = this.transformISOStringsToDate(data[key], propertySchema)
                }
            }

            return result
        }

        // Return other primitives as is
        return data
    }

    /**
     * Parse and validate an array of JSON data, converting string date-time formats to Date objects
     * @param dataList The array of JSON data to parse and validate
     * @returns The validated data array with ISO 8601 strings converted to Date objects
     */
    parseList<U extends Record<string, any>>(dataList: U[]): T[] {
        // Create a copy of the data to avoid modifying the original
        const dataCopy = JSON.parse(JSON.stringify(dataList))

        // First validate the list to ensure it matches the schema
        this.validateList(dataCopy)

        // Then transform each item
        return dataCopy.map((item: any) => this.transformISOStringsToDate(item, this.schemaObject))
    }

    /**
     * @experimental This function might not handle properly all cases and its design is subject to change in the future
     *
     * Generate the typescript code equivalent of the current schema.
     * Useful when you want to generate code for an OpenAPI document while keeping the concise aspect of SchemaBuilder.
     * @param customizeOutput you can provide a function to customize or replace entirely the output for a given Schema
     * @returns The generated variable name for the schema based on its "title" and the typescript code that should produce an equivalent schema
     */
    toTypescript(customizeOutput?: (output: string, s: SchemaBuilder<any>) => string) {
        return [this.schemaObject.title ? `${_.lowerFirst(this.schemaObject.title)}Schema` : "schema", this._toTypescript(true, customizeOutput)] as const
    }

    /**
     * Internal version of `toTypescript` used for recursion.
     * Recursive calls will have `processNamedSchema` set to `false` and will stop the recursion on any schema where the title is set.
     */
    private _toTypescript(processNamedSchema: boolean, customizeOutput: ((output: string, s: SchemaBuilder<any>) => string) | undefined): string {
        function getSchemaBuilder(schemaObject: boolean | JSONSchema | undefined): SchemaBuilder<any> {
            if (schemaObject === true || schemaObject === undefined) {
                return SchemaBuilder.anySchema()
            }
            if (schemaObject === false) {
                return SchemaBuilder.noneSchema()
            }
            return new SchemaBuilder(schemaObject)
        }
        function optionalStringify(obj: any, force = false, prefix = "") {
            let result = force || (obj !== undefined && Object.keys(obj).length) ? JSON.stringify(obj) : undefined
            result = result ? `${prefix}${result}` : ""
            return result
        }
        const o = customizeOutput ?? ((output: string, s: SchemaBuilder<any>) => output)
        if (!processNamedSchema && this.schemaObject.title) {
            // Named schema should be handled separately. Generate its variable name instead of its schema code.
            return o(`${_.lowerFirst(this.schemaObject.title)}Schema`, this)
        }
        let { type, ...restOfSchemaObject } = this.schemaObject
        if (type) {
            let isNull = false
            if (restOfSchemaObject.enum) {
                const { enum: enumSchemaObject, ...restOfSchemaObjectForEnum } = restOfSchemaObject
                return o(`SB.enumSchema(${JSON.stringify(enumSchemaObject)}, ${optionalStringify(restOfSchemaObjectForEnum)})`, this)
            }
            if (Array.isArray(type)) {
                if (type.length === 0) {
                    return o(`SB.neverSchema(${optionalStringify(restOfSchemaObject)})`, this)
                }
                if (type.length === 1) {
                    type = type[0]
                }
                if (Array.isArray(type) && type.length === 2 && type[0] !== "null" && type[1] === "null") {
                    type = type[0]
                    isNull = true
                }
            }
            if (!Array.isArray(type)) {
                switch (type) {
                    case "string":
                    case "boolean":
                    case "integer":
                    case "number":
                        return o(`SB.${type}Schema(${optionalStringify(restOfSchemaObject, isNull)}${isNull ? ", true" : ""})`, this)
                    case "null":
                        return o(`SB.nullSchema(${optionalStringify(restOfSchemaObject)})`, this)
                    case "array":
                        const { items, ...restOfSchemaObjectForArray } = restOfSchemaObject
                        if (Array.isArray(items)) {
                            throw new Error(`Unimplemented tuple`) // @todo fix implementation when tuple are part of SchemaBuilder methods
                        }
                        return o(
                            `SB.arraySchema(${getSchemaBuilder(items)._toTypescript(false, customizeOutput)}${optionalStringify(
                                restOfSchemaObjectForArray,
                                isNull,
                                ", ",
                            )}${isNull ? ", true" : ""})`,
                            this,
                        )
                    case "object":
                        const { properties, required, additionalProperties, ...restOfSchemaObjectForObject } = restOfSchemaObject
                        return o(
                            `SB.objectSchema(${JSON.stringify(restOfSchemaObjectForObject)}, {${Object.entries(properties ?? {})
                                .map((v) => {
                                    const propertySchemaCode = getSchemaBuilder(v[1])._toTypescript(false, customizeOutput)
                                    return `"${v[0]}": ${required?.includes(v[0]) ? propertySchemaCode : `[${propertySchemaCode}, undefined]`}`
                                })
                                .join(", ")}}${isNull ? ", true" : ""})${
                                additionalProperties
                                    ? `.addAdditionalProperties(${
                                          additionalProperties === true ? "" : getSchemaBuilder(additionalProperties)._toTypescript(false, customizeOutput)
                                      })`
                                    : ""
                            }`,
                            this,
                        )
                }
            }
        } else if (restOfSchemaObject.allOf) {
            return o(
                `SB.allOf(${restOfSchemaObject.allOf.map((schemaObject) => getSchemaBuilder(schemaObject)._toTypescript(false, customizeOutput)).join(", ")})`,
                this,
            )
        } else if (restOfSchemaObject.oneOf) {
            return o(
                `SB.oneOf(${restOfSchemaObject.oneOf.map((schemaObject) => getSchemaBuilder(schemaObject)._toTypescript(false, customizeOutput)).join(", ")})`,
                this,
            )
        } else if (restOfSchemaObject.anyOf) {
            return o(
                `SB.anyOf(${restOfSchemaObject.anyOf.map((schemaObject) => getSchemaBuilder(schemaObject)._toTypescript(false, customizeOutput)).join(", ")})`,
                this,
            )
        } else if (restOfSchemaObject.not) {
            return o(`SB.not(${getSchemaBuilder(restOfSchemaObject.not)._toTypescript(false, customizeOutput)})`, this)
        }
        // default to a literal schema for unhandled cases
        return o(`SB.fromJsonSchema(${JSON.stringify(this.schemaObject)} as const)`, this)
    }

    /**
     * This property makes the access to the underlying T type easy.
     * You can do things like type MyModel = typeof myModelSchemaBuilder.T
     * Or use GenericType["T"] in a generic type definition.
     * It's not supposed to be set or accessed
     */
    readonly T: T = null as any
}

function validationError(ajvErrorsText: string, errorsDetails: any) {
    let opt: any = {
        name: "SerafinSchemaValidationError",
        info: {
            ajvErrors: errorsDetails,
        },
    }
    return new VError(opt, `Invalid parameters: ${ajvErrorsText}`)
}

export type JSONSchemaCommonProperties = "title" | "description" | "default" | "examples" | "readOnly" | "writeOnly"

export type JSONSchemaArraySpecificProperties = "maxItems" | "minItems" | "uniqueItems"

export type JSONSchemaArrayProperties = JSONSchemaCommonProperties | JSONSchemaArraySpecificProperties

export type JSONSchemaStringProperties = JSONSchemaCommonProperties | "maxLength" | "minLength" | "pattern" | "format"

export type JSONSchemaNumberProperties = JSONSchemaCommonProperties | "multipleOf" | "maximum" | "exclusiveMaximum" | "minimum" | "exclusiveMinimum"

export type JSONSchemaEnumProperties = JSONSchemaCommonProperties

export type JSONSchemaBooleanProperties = JSONSchemaCommonProperties

export type JSONSchemaObjectProperties = JSONSchemaCommonProperties | "maxProperties" | "minProperties"

export type JSONSchemaGeneralProperties = JSONSchemaCommonProperties

export const SB = SchemaBuilder // shorter alias
