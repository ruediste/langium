/******************************************************************************
 * Copyright 2022 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { Grammar, Interface, ParserRule, Type } from '../generated/ast';
import { getRuleType } from '../grammar-util';
import { MultiMap } from '../../utils/collections';
import { collectDeclaredTypes } from './declared-types';
import { collectInferredTypes } from './inferred-types';
import { AstTypes, collectAllAstResources, distictAndSorted, Property, PropertyType, propertyTypeArrayToString, InterfaceType, UnionType, AstResources } from './types-util';
import { stream } from '../../utils/stream';
import { ValidationAcceptor } from '../../validation/validation-registry';
import { extractAssignments } from '../../utils/ast-util';

export function validateTypesConsistency(grammar: Grammar, accept: ValidationAcceptor): void {
    function applyErrorToRuleNodes(nodes: readonly ParserRule[], typeName: string): (errorMessage: string) => void {
        return (errorMessage: string) => {
            nodes.forEach(node => accept('error',
                errorMessage + ` in a rule that returns type '${typeName}'.`,
                { node: node?.inferredType ? node.inferredType : node, property: 'name' }
            ));
        };
    }

    const validationResources = collectValidationResources(grammar);
    for (const [typeName, typeInfo] of validationResources.entries()) {
        if (!isInferredAndDeclared(typeInfo)) continue;
        const errorToRuleNodes = applyErrorToRuleNodes(typeInfo.nodes, typeName);
        const errorToAssignment = applyErrorToAssignment(typeInfo.nodes, accept);

        if (isType(typeInfo.inferred) && isType(typeInfo.declared)) {
            checkAlternativesConsistency(typeInfo.inferred.union, typeInfo.declared.union, errorToRuleNodes);
        } else if (isInterface(typeInfo.inferred) && isInterface(typeInfo.declared)) {
            checkPropertiesConsistency(typeInfo.inferred.properties, typeInfo.declared.properties, errorToRuleNodes, errorToAssignment);
            checkSuperTypesConsistency([...typeInfo.inferred.superTypes], [...typeInfo.declared.superTypes], errorToRuleNodes);
        } else {
            const specificError = `Inferred and declared versions of type ${typeName} have to be types or interfaces both.`;
            typeInfo.nodes.forEach(node => accept('error', specificError,
                { node: node?.inferredType ? node.inferredType : node, property: 'name' }
            ));
            accept('error', specificError,
                { node: typeInfo.node, property: 'name' }
            );
        }
    }
}

export function applyErrorToAssignment(nodes: readonly ParserRule[], accept: ValidationAcceptor): (propertyName: string, errorMessage: string) => void {
    const assignmentNodes = nodes.flatMap(node => extractAssignments(node.alternatives));
    return (propertyName: string, errorMessage: string) => {
        const node = assignmentNodes.find(assignment => assignment.feature === propertyName);
        if (node) {
            accept('error',
                errorMessage,
                { node, property: 'feature' }
            );
        }
    };
}

type TypeOrInterface = UnionType | InterfaceType;

function isType(type: TypeOrInterface): type is UnionType {
    return type && 'union' in type;
}

function isInterface(type: TypeOrInterface): type is InterfaceType {
    return type && 'properties' in type;
}

type InferredInfo = {
    inferred: TypeOrInterface;
    nodes: readonly ParserRule[];
}

type DeclaredInfo = {
    declared: TypeOrInterface;
    node: Type | Interface;
}

function isInferredAndDeclared(type: InferredInfo | DeclaredInfo | InferredInfo & DeclaredInfo): type is InferredInfo & DeclaredInfo {
    return type && 'inferred' in type && 'declared' in type;
}

type ValidationResources = Map<string, InferredInfo | DeclaredInfo | InferredInfo & DeclaredInfo>;

export function collectValidationResources(grammar: Grammar): ValidationResources {
    const astResources = collectAllAstResources([grammar]);
    const inferred = collectInferredTypes(Array.from(astResources.parserRules), Array.from(astResources.datatypeRules));
    const declared = collectDeclaredTypes(Array.from(astResources.interfaces), Array.from(astResources.types), inferred);

    const typeNameToRules = getTypeNameToRules(astResources);
    const inferredInfo = mergeTypesAndInterfaces(inferred)
        .reduce((acc, type) => acc.set(type.name, { inferred: type, nodes: typeNameToRules.get(type.name) }),
            new Map<string, InferredInfo>()
        );

    const allTypesInfo = mergeTypesAndInterfaces(declared)
        .reduce((acc, type) => {
            const node = stream(astResources.types).find(e => e.name === type.name) ??
                stream(astResources.interfaces).find(e => e.name === type.name);
            if (node) {
                const inferred = inferredInfo.get(type.name);
                acc.set(type.name, inferred ? {...inferred, declared: type, node } : { declared: type, node });
            }
            return acc;
        }, new Map<string, InferredInfo | DeclaredInfo | InferredInfo & DeclaredInfo>());

    return allTypesInfo;
}

function getTypeNameToRules(astResources: AstResources): MultiMap<string, ParserRule> {
    return stream(astResources.parserRules)
        .concat(astResources.datatypeRules)
        .reduce((acc, rule) => acc.add(getRuleType(rule), rule),
            new MultiMap<string, ParserRule>()
        );
}

function mergeTypesAndInterfaces(astTypes: AstTypes): TypeOrInterface[] {
    return (astTypes.interfaces as TypeOrInterface[]).concat(astTypes.unions);
}

type ErrorInfo = {
    errorMessage: string;
    typeString: string;
}

const arrRefError = (found: PropertyType, expected: PropertyType) =>
    found.array && !expected.array && found.reference && !expected.reference ? 'can\'t be an array and a reference' :
        !found.array && expected.array && !found.reference && expected.reference ? 'has to be an array and a reference' :
            found.array && !expected.array ? 'can\'t be an array' :
                !found.array && expected.array ? 'has to be an array' :
                    found.reference && !expected.reference ? 'can\'t be a reference' :
                        !found.reference && expected.reference ? 'has to be a reference' : '';

function checkAlternativesConsistencyHelper(found: PropertyType[], expected: PropertyType[]): ErrorInfo[] {
    const stringToPropertyTypeList = (propertyTypeList: PropertyType[]) =>
        propertyTypeList.reduce((acc, e) => acc.set(distictAndSorted(e.types).join(' | '), e), new Map<string, PropertyType>());

    const stringToFound = stringToPropertyTypeList(found);
    const stringToExpected = stringToPropertyTypeList(expected);
    const errorsInfo: ErrorInfo[] = [];

    // detects extra type alternatives & check matched ones on consistency by 'array' and 'reference'
    for (const [typeString, foundPropertyType] of stream(stringToFound)) {
        const expectedPropertyType = stringToExpected.get(typeString);
        if (!expectedPropertyType) {
            errorsInfo.push({ typeString, errorMessage: 'is not expected' });
        } else if (expectedPropertyType.array !== foundPropertyType.array || expectedPropertyType.reference !== foundPropertyType.reference) {
            errorsInfo.push({ typeString, errorMessage: arrRefError(foundPropertyType, expectedPropertyType) });
        }
    }

    return errorsInfo;
}

function checkAlternativesConsistency(inferred: PropertyType[], declared: PropertyType[], errorToRuleNodes: (error: string) => void): void {
    const errorsInfo = checkAlternativesConsistencyHelper(inferred, declared);
    for (const errorInfo of errorsInfo) {
        errorToRuleNodes(`A type '${errorInfo.typeString}' ${errorInfo.errorMessage}`);
    }
}

function checkPropertiesConsistency(inferred: Property[], declared: Property[],
    errorToRuleNodes: (error: string) => void, errorToAssignment: (propertyName: string, error: string) => void): void {

    const baseError = (propertyName: string, foundType: string, expectedType: string) =>
        `The assigned type '${foundType}' is not compatible with the declared property '${propertyName}' of type '${expectedType}'.`;

    const checkOptional = (found: Property, expected: Property) =>
        !(found.typeAlternatives.length === 1 && found.typeAlternatives[0].array ||
            expected.typeAlternatives.length === 1 && expected.typeAlternatives[0].array);

    // detects extra properties & check matched ones on consistency by 'opional'
    for (const foundProperty of inferred) {
        const expectedProperty = declared.find(e => foundProperty.name === e.name);
        if (expectedProperty) {
            const foundStringType = propertyTypeArrayToString(foundProperty.typeAlternatives);
            const expectedStringType = propertyTypeArrayToString(expectedProperty.typeAlternatives);
            if (foundStringType !== expectedStringType) {
                const typeAlternativesErrors = checkAlternativesConsistencyHelper(foundProperty.typeAlternatives, expectedProperty.typeAlternatives);
                if (typeAlternativesErrors.length > 0) {
                    let resultError = baseError(foundProperty.name, foundStringType, expectedStringType);
                    for (const errorInfo of typeAlternativesErrors) {
                        resultError = resultError + ` '${errorInfo.typeString}' ${errorInfo.errorMessage};`;
                    }
                    resultError = resultError.replace(/;$/, '.');
                    errorToAssignment(foundProperty.name, resultError);
                }
            }

            if (checkOptional(foundProperty, expectedProperty) && !expectedProperty.optional && foundProperty.optional) {
                errorToAssignment(foundProperty.name, `A property '${foundProperty.name}' can't be optional.`);
            }
        } else {
            errorToAssignment(foundProperty.name, `A property '${foundProperty.name}' is not expected.`);
        }
    }

    // detects lack of properties
    for (const foundProperty of declared) {
        const expectedProperty = inferred.find(e => foundProperty.name === e.name);
        if (!expectedProperty) {
            errorToRuleNodes(`A property '${foundProperty.name}' is expected`);
        }
    }
}

function checkSuperTypesConsistency(inferred: string[], declared: string[], errorToRuleNodes: (error: string) => void): void {
    const specificError = (superType: string, isExtra: boolean) => `A super type '${superType}' is ${isExtra ? 'not ' : ''}expected`;

    inferred
        .filter(e => !declared.includes(e))
        .forEach(extraSuperType => errorToRuleNodes(specificError(extraSuperType, true)));

    declared
        .filter(e => !inferred.includes(e))
        .forEach(lackSuperType => errorToRuleNodes(specificError(lackSuperType, false)));
}

export type InterfaceInfo = {
    type: InterfaceType;
    node: Interface | readonly ParserRule[];
}

// use only after type consistancy validation
export function collectAllInterfaces(grammar: Grammar): Map<string, InterfaceInfo> {
    const astResources = collectAllAstResources([grammar]);
    const inferred = collectInferredTypes(Array.from(astResources.parserRules), Array.from(astResources.datatypeRules));
    const declared = collectDeclaredTypes(Array.from(astResources.interfaces), Array.from(astResources.types), inferred);

    const typeNameToRules = getTypeNameToRules(astResources);
    const inferredInterfaces = inferred.interfaces
        .reduce((acc, type) => acc.set(type.name, { type, node: typeNameToRules.get(type.name) }),
            new Map<string, InterfaceInfo>()
        );

    return declared.interfaces
        .reduce((acc, type) => {
            if (!acc.has(type.name)) {
                const node = stream(astResources.interfaces).find(e => e.name === type.name);
                if (node) acc.set(type.name, { type, node });
            }
            return acc;
        }, inferredInterfaces);
}
