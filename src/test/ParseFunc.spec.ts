import { SchemaBuilder as SB, SchemaBuilder } from "../SchemaBuilder"

import { createPropertyAccessor } from "../PropertyAccessor"
import { expect } from "chai"

describe("SchemaBuilder number parsing", function () {
    it("should work", function () {
        expect(true).to.be.true
    })

    it("should handle mixed object with string numbers", function () {
        const data = {
            stringField: "text",
            numberField: "45.67",
            integerField: "89.12",
            dateField: "2023-01-15T12:00:00Z",
            objectField: {
                nestedNumber: "12.34",
                nestedString: "test",
            },
            arrayField: ["1", "2.5", "3.75"],
        }

        const mixedSchema = SB.objectSchema(
            { title: "MixedObject" },
            {
                stringField: SB.stringSchema(),
                numberField: SB.numberSchema(),
                integerField: SB.integerSchema(),
                dateField: SB.dateSchema(),
                objectField: SB.objectSchema(
                    {},
                    {
                        nestedNumber: SB.numberSchema(),
                        nestedString: SB.stringSchema(),
                    },
                ),
                arrayField: SB.arraySchema(SB.numberSchema()),
            },
        )

        const result = mixedSchema.parse(data)

        expect(typeof result.numberField).to.equal("number")
        expect(result.numberField).to.equal(45.67)

        expect(typeof result.integerField).to.equal("number")
        expect(result.integerField).to.equal(89)
        expect(Number.isInteger(result.integerField)).to.be.true

        expect(result.stringField).to.equal("text")
        expect(result.dateField).to.be.instanceOf(Date)

        expect(typeof result.objectField.nestedNumber).to.equal("number")
        expect(result.objectField.nestedNumber).to.equal(12.34)
        expect(result.objectField.nestedString).to.equal("test")

        expect(Array.isArray(result.arrayField)).to.be.true
        expect(result.arrayField.length).to.equal(3)
        expect(typeof result.arrayField[0]).to.equal("number")
        expect(result.arrayField[0]).to.equal(1)
        expect(result.arrayField[1]).to.equal(2.5)
    })
})
